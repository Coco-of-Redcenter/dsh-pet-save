/**
 * dsh-pet desktop helper —— 「显示范围」的纯判定 + 规则常量。
 *
 * 【这一档解决什么】
 *   桌宠窗口是 alwaysOnTop + 'screen-saver' 层（见 main.js 的建窗与置顶看门狗），它必然浮在
 *   所有普通窗口之上——用户打开浏览器/微信时桌宠照旧压在它们上面。Windows 上 Electron 没有
 *   原生「只贴桌面」的窗口类型，所以 'desktop' 档靠**检测当前前台窗口是不是桌面**来兑现：
 *   前台从桌面切到别的软件 → 藏起宠物；切回桌面 → 再冒出来。
 *
 * 【为什么判定逻辑落在 runtime/ 而不是 src/shared】
 *   本文件是 CommonJS、由 Electron 主进程用 require 加载（Electron 主进程不进任何打包链，
 *   桌面资源一律走 runtime/ 的散装 .js，见 main.js 的 require 列表）。src/shared 那份
 *   TypeScript 只保留「档位白名单」这一层给设置页与浏览器用（src/shared/display-scope.ts），
 *   判定规则只在**真正执行它**的这边定义一次，避免两处各写一套走样。
 *
 * 测试：scripts/tests/display-scope.test.mjs
 */

'use strict';

/** 桌宠显示范围三档：仅桌面 / 全部软件 / 关闭（顺序 = 界面上从最克制到最放开，关闭放最后） */
const DISPLAY_SCOPES = ['desktop', 'all', 'off'];

/**
 * 内置默认：全部软件 —— 与引入本档位之前的行为完全一致（桌宠一直浮在最上层），
 * 老用户升级后观感不变，只有主动去设置页 / 右键菜单选了别的档才改变。
 */
const DEFAULT_DISPLAY_SCOPE = 'all';

/** 档位白名单判定 */
const isDisplayScope = (value) => value === 'desktop' || value === 'all' || value === 'off';

/** 任意输入 → 合法档位（非法/缺失一律回落默认），保证两端读同一个脏值得到同一结果 */
const toDisplayScope = (value) => (isDisplayScope(value) ? value : DEFAULT_DISPLAY_SCOPE);

/**
 * 前台窗口的类名 → 它是不是「桌面」。
 *
 * 依据（本机实测：把焦点切到桌面时 GetForegroundWindow 给的就是这些类）：
 *   - `Progman`      桌面管理器窗口（标题 "Program Manager"）；
 *   - `WorkerW`      桌面壁纸层。/ 动 / 壁纸类软件（Wallpaper Engine 等）常把画面挂在这一层，
 *                    此时前台类名同为 WorkerW——对用户而言那仍然是"桌面"，故一并算桌面；
 *   - `Shell_TrayWnd` 任务栏。点任务栏空白处时它就当前台窗口；桌宠不该因为"点了下任务栏"
 *                    就消失，所以也算桌面。
 * 其余类名（Chrome_WidgetWin_1 / WeChatMainWndForPC / CabinetWClass …）一律算"别的软件"。
 *
 * 空类名（探测失败 / 前台窗口刚销毁）按**不是桌面**处理：宁可多藏一次，也别在用户开着
 * 别的软件时把宠物糊在人脸上——下一拍拿到真实类名就会纠正。
 */
const DESKTOP_CLASSES = ['Progman', 'WorkerW', 'Shell_TrayWnd'];

/** 该类名是否代表桌面（纯字符串判定，探测与解析的接缝处用） */
const isDesktopClass = (className) => DESKTOP_CLASSES.indexOf(String(className || '')) >= 0;

/** 前台信息 → 是不是桌面。probe 不可用（非 Windows / 起不来）时恒为 false，
 *  由 decideWindowVisible 的 scope==='desktop' 分支决定回落行为。 */
const foregroundIsDesktop = (foreground) => isDesktopClass(foreground && foreground.className);

/**
 * 按显示范围与前台状态决定**某个桌宠窗口此刻该不该可见**。
 *
 * @param {object} input
 * @param {'desktop'|'all'|'off'} input.scope       当前档位（非法值按默认档处理）
 * @param {boolean} input.foregroundIsDesktop       当前前台窗口是不是桌面
 * @param {boolean} input.petWindowIsForeground     当前前台窗口是不是**这个**桌宠窗口自己
 *        （用户刚点了桌宠 / 正在拖它 / 右键菜单开着 → 焦点可能已经落到宠物窗上；
 *          不看这一条的话，'desktop' 档下宠物会在被点中的那一瞬间把自己藏掉）
 * @param {boolean} input.probeAvailable            前台探测通道是否可用（非 Windows / 起不来 = false）
 * @returns {boolean} true = 该显示，false = 该藏起
 */
function decideWindowVisible(input) {
  const scope = toDisplayScope(input && input.scope);
  if (scope === 'off') return false;
  if (scope === 'all') return true;
  // scope === 'desktop'
  const petIsForeground = !!(input && input.petWindowIsForeground);
  if (petIsForeground) return true;
  // 探测通道不可用（非 Windows 平台，或 PowerShell 起不来）：降级成"一直可见"，
  // 绝不把桌宠藏到一个用户无法恢复的状态里——宁可视同 'all'，也不静默失踪。
  if (!(input && input.probeAvailable)) return true;
  return !!(input && input.foregroundIsDesktop);
}

module.exports = {
  DISPLAY_SCOPES,
  DEFAULT_DISPLAY_SCOPE,
  DESKTOP_CLASSES,
  isDisplayScope,
  toDisplayScope,
  isDesktopClass,
  foregroundIsDesktop,
  decideWindowVisible,
};
