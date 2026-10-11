// 桌面桌宠的「显示范围」——全局一档三选一，控制**桌面模式（Electron 透明小窗）**这只桌宠
// 出现在哪些软件之上。与宠物条目自己的 display（web/desktop/both/none，见 types.ts）正交：
//   - display 决定「这只宠物要不要桌宠窗口、要不要网页 overlay」，是**每只宠物**的显示位置；
//   - displayScope 决定「已经存在的桌宠窗口该露在哪儿」，是**全局**的可见范围。
//
// 为什么需要这一档：桌宠窗口是 alwaysOnTop + 'screen-saver' 层（runtime/electron-helper/main.js），
// 它必然浮在所有普通窗口之上——打开浏览器/微信时桌宠照旧压在它们上面。Windows 上 Electron 没有
// 原生「只贴桌面」的窗口类型，所以 desktop 档由 helper 检测**当前前台窗口是不是桌面**来兑现：
// 前台从桌面切到别的软件就藏起宠物，切回桌面再冒出来（判定见 runtime/electron-helper/
// foreground-probe.js 与 display-scope.js）。
//
// 纯逻辑 + 常量（无 React / DOM）：浏览器 bundle、桌面 shared-core 与宿主三边共用同一份。

/** 桌宠显示范围的三个档位 */
export type DisplayScope = 'desktop' | 'all' | 'off';

/** 全部档位（顺序 = 设置页与右键菜单里的展示顺序：从最克制到最放开，关闭放最后） */
export const DISPLAY_SCOPES: DisplayScope[] = ['desktop', 'all', 'off'];

/** 内置默认：全部软件 —— 与本次改动上线前的行为完全一致（桌宠一直浮在最上层），
 *  所以老用户升级后观感不变，只有主动去设置页/右键菜单选了别的档才改变。 */
export const DEFAULT_DISPLAY_SCOPE: DisplayScope = 'all';

/** 档位白名单判定（未知值交给调用方决定回落，本函数只回答"是不是合法档位"） */
export function isDisplayScope(value: unknown): value is DisplayScope {
  return value === 'desktop' || value === 'all' || value === 'off';
}

/** 档位 → 中文短标签。
 *
 *  单一来源：桌面端右键菜单没有勾选态，只能把当前档位写进标签（「显示范围：仅桌面」），
 *  直接复用这里；设置页的中英长标签另有一份（settings.ts 的 'scope.*' 文案键，
 *  那里要带每个选项的说明，且要出英文）。两处的**档位名称**必须一致，改这里也要改那边。
 *  浏览器端没有这一档（overlay 只活在页面内），所以只有桌面端消费它。 */
export const DISPLAY_SCOPE_LABELS: Record<DisplayScope, string> = {
  desktop: '仅桌面',
  all: '全部软件',
  off: '关闭',
};

/** 任意输入 → 合法档位（非法/缺失一律回落内置默认）。host 读用户配置、renderer 读
 *  /state 的 data 都走它，保证两端对同一个脏值得到同一个结果。 */
export function toDisplayScope(value: unknown): DisplayScope {
  return isDisplayScope(value) ? value : DEFAULT_DISPLAY_SCOPE;
}
