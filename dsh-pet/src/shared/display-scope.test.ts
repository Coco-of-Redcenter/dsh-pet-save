/**
 * 桌宠「显示范围」（仅桌面 / 全部软件 / 关闭）的纯逻辑回归。
 *
 * 被测对象是 **runtime/electron-helper** 的两个 CommonJS 模块（Electron 主进程用 require 加载，
 * 不进任何打包链）：
 *   display-scope.js    档位白名单 + 前台类名判定 + 可见性判定（本功能的核心规则）
 *   foreground-probe.js 探测输出行的解析（半行 / 混入日志 / 脏 JSON 都不能污染状态）
 *
 * 为什么用 createRequire 而不是 import：那两个文件是 CommonJS（桌面资源一律走 runtime/ 的
 * 散装 .js，见 main.js 的 require 列表），ESM 侧要用 require 桥接到同一份源码——
 * 与 src/host/pointer-target.test.ts 读 helper 源码是同一套"helper 只能从外部验证"的思路。
 *
 * 真正的 Win32 前台切换需要一台有桌面会话的 Windows（CI 里没有），所以这里只钉纯判定；
 * SetWinEventHook 那条链路由 PR 说明里的实测记录覆盖。
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const helperDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'runtime', 'electron-helper');

const scope = require(join(helperDir, 'display-scope.js')) as {
  DISPLAY_SCOPES: string[];
  DEFAULT_DISPLAY_SCOPE: string;
  DESKTOP_CLASSES: string[];
  isDisplayScope: (v: unknown) => boolean;
  toDisplayScope: (v: unknown) => string;
  isDesktopClass: (v: unknown) => boolean;
  foregroundIsDesktop: (v: unknown) => boolean;
  decideWindowVisible: (input: unknown) => boolean;
};
const probe = require(join(helperDir, 'foreground-probe.js')) as {
  parseProbeLine: (line: unknown) => { hwnd: number; className: string; title: string } | null;
};

describe('显示范围 —— 档位白名单', () => {
  test('只认三档，顺序 = 界面上从最克制到最放开（关闭放最后）', () => {
    assert.deepEqual(scope.DISPLAY_SCOPES, ['desktop', 'all', 'off']);
    for (const value of scope.DISPLAY_SCOPES) assert.equal(scope.isDisplayScope(value), true);
  });

  test('非法档位一律回落内置默认「全部软件」（= 引入本功能之前的观感）', () => {
    assert.equal(scope.DEFAULT_DISPLAY_SCOPE, 'all');
    for (const bad of [undefined, null, '', 'DESKTOP', 'both', 'web', 'none', 0, 1, {}, [], 'desktop ']) {
      assert.equal(scope.isDisplayScope(bad), false, `${String(bad)} 不该被判成合法档位`);
      assert.equal(scope.toDisplayScope(bad), 'all', `${String(bad)} 该回落默认档`);
    }
  });
});

describe('显示范围 —— 前台类名 → 是不是桌面', () => {
  test('桌面外壳的类名算桌面：Progman / WorkerW / Shell_TrayWnd', () => {
    // Progman = 桌面管理器；WorkerW = 壁纸层（壁纸引擎类软件也挂这里）；Shell_TrayWnd = 任务栏
    assert.equal(scope.isDesktopClass('Progman'), true);
    assert.equal(scope.isDesktopClass('WorkerW'), true);
    assert.equal(scope.isDesktopClass('Shell_TrayWnd'), true);
    assert.deepEqual(scope.DESKTOP_CLASSES, ['Progman', 'WorkerW', 'Shell_TrayWnd']);
  });

  test('普通软件窗口的类名不算桌面', () => {
    for (const cls of ['Chrome_WidgetWin_1', 'WeChatMainWndForPC', 'CabinetWClass', 'Notepad', 'Qt51514QWindowIcon']) {
      assert.equal(scope.isDesktopClass(cls), false, `${cls} 不该算桌面`);
    }
  });

  test('空/缺失类名按「不是桌面」处理（宁可多藏一次，也别糊在别的软件上）', () => {
    for (const bad of ['', undefined, null, 0, false, {}]) assert.equal(scope.isDesktopClass(bad), false);
  });

  test('foregroundIsDesktop 只认探测对象里的 className（形状不对不抛）', () => {
    assert.equal(scope.foregroundIsDesktop({ className: 'Progman' }), true);
    assert.equal(scope.foregroundIsDesktop({ className: 'Chrome_WidgetWin_1' }), false);
    assert.equal(scope.foregroundIsDesktop(null), false);
    assert.equal(scope.foregroundIsDesktop(undefined), false);
    assert.equal(scope.foregroundIsDesktop({}), false);
  });
});

describe('显示范围 —— 可见性判定（本功能的核心规则）', () => {
  /** 判定入参默认值：全部软件档、探测可用、前台是别的软件、宠物窗不是前台 */
  const decide = (over: Record<string, unknown> = {}): boolean =>
    scope.decideWindowVisible({
      scope: 'all',
      foregroundIsDesktop: false,
      petWindowIsForeground: false,
      probeAvailable: true,
      ...over,
    });

  test('全部软件：无论前台是谁都显示', () => {
    assert.equal(decide({ scope: 'all', foregroundIsDesktop: false }), true);
    assert.equal(decide({ scope: 'all', foregroundIsDesktop: true }), true);
    assert.equal(decide({ scope: 'all', petWindowIsForeground: true }), true);
  });

  test('关闭：一律不显示（前台、探测可用性都不影响）', () => {
    for (const foregroundIsDesktop of [true, false]) {
      for (const probeAvailable of [true, false]) {
        assert.equal(decide({ scope: 'off', foregroundIsDesktop, probeAvailable }), false);
      }
    }
  });

  test('仅桌面：前台是桌面才显示，前台是别的软件就藏起来', () => {
    assert.equal(decide({ scope: 'desktop', foregroundIsDesktop: true }), true);
    assert.equal(decide({ scope: 'desktop', foregroundIsDesktop: false }), false);
  });

  test('仅桌面：正在被点的桌宠窗口自己当前台时保持显示（否则点中的一瞬间会把自己藏掉）', () => {
    assert.equal(decide({ scope: 'desktop', petWindowIsForeground: true, foregroundIsDesktop: false }), true);
  });

  test('仅桌面 + 探测通道不可用：降级为一直可见，绝不把桌宠藏到用户找不回', () => {
    assert.equal(decide({ scope: 'desktop', probeAvailable: false, foregroundIsDesktop: false }), true);
    assert.equal(decide({ scope: 'desktop', probeAvailable: false, foregroundIsDesktop: true }), true);
  });

  test('非法档位按默认档（全部软件）判定，不会因为配置写坏而藏起宠物', () => {
    assert.equal(decide({ scope: 'bogus', foregroundIsDesktop: false }), true);
    assert.equal(scope.decideWindowVisible({}), true); // 入参整个缺失也不抛
  });

  test('入参缺失/为 null 时不抛，按「安全的一侧」判定', () => {
    assert.equal(scope.decideWindowVisible(null), true);
    assert.equal(scope.decideWindowVisible(undefined), true);
  });
});

describe('显示范围 —— 前台探测输出行的解析', () => {
  test('合法探测行解析出 hwnd / className / title', () => {
    const line = '{"hwnd":131432,"className":"Progman","title":"Program Manager"}';
    assert.deepEqual(probe.parseProbeLine(line), {
      hwnd: 131432,
      className: 'Progman',
      title: 'Program Manager',
    });
  });

  test('标题缺失补空串、hwnd 非法归 0（只用 className 判定，其余字段不能让解析失败）', () => {
    assert.deepEqual(probe.parseProbeLine('{"hwnd":7,"className":"WorkerW"}'), {
      hwnd: 7,
      className: 'WorkerW',
      title: '',
    });
    assert.deepEqual(probe.parseProbeLine('{"hwnd":"x","className":"Progman"}'), {
      hwnd: 0,
      className: 'Progman',
      title: '',
    });
  });

  test('脏输入（空行 / 半行 / 非 JSON / 缺 className / 坏 JSON）一律 null', () => {
    for (const bad of [
      '',
      '   ',
      '{',
      '{"hwnd":1,',
      'not json',
      'SetWinEventHook failed',
      '{"hwnd":1,"title":"no class"}',
      '{"className":123}',
      '[]',
      'null',
      '{"className":"Progman"',
    ]) {
      assert.equal(probe.parseProbeLine(bad), null, `${JSON.stringify(bad)} 不该被当成合法状态`);
    }
  });

  test('行首尾带空白/\\r 的合法行仍能解析（stdout 分块时行尾可能是 \\r\\n）', () => {
    assert.equal(probe.parseProbeLine('\r\n{"hwnd":1,"className":"WorkerW"}\r')?.className, 'WorkerW');
  });
});
