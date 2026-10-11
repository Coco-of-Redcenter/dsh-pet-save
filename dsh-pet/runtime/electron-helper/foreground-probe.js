/**
 * dsh-pet desktop helper —— 「当前前台窗口是谁」的探测通道（Windows 专用）。
 *
 * 【为什么需要】'desktop' 档要求桌宠"只出现在桌面上"：前台是别的软件就藏起来、回桌面再冒出来。
 *   这项判断没有任何 Electron / Node 原生 API 能给，只能问 Win32 的 GetForegroundWindow。
 *
 * 【为什么不是轮询】轮询 ForegroundWindow 要么占着主进程（setInterval + 同步系统调用），
 *   要么每拍拉一个子进程（进程创建成本、还有控制台窗口闪烁的风险）。这里改成**事件驱动**：
 *   在一个常驻的 PowerShell 子进程里用 SetWinEventHook 监听 EVENT_SYSTEM_FOREGROUND
 *   （+ EVENT_OBJECT_NAMECHANGE），只在**前台真的换了**才写一行 JSON 到 stdout，本进程读行。
 *   没有轮询、没有稳定态开销；子进程与 helper 同生共死。
 *
 * 【协议】子进程 stdout 每行一个 JSON：
 *   {"className":"Chrome_WidgetWin_1","title":"…"}
 *   类名 → 是不是桌面 的判定不在这里做（见 display-scope.js 的 isDesktopClass），
 *   本模块只负责如实搬运"当前前台窗口的类名与标题"。
 *   stderr 只用于排障，原样转给调用方的日志。
 *
 * 【降级】任何一步失败（非 Windows / PowerShell 起不来 / 脚本编译失败）→ 本模块
 *   onState 都不报可用，调用方（main.js）把 probeAvailable 记成 false，decideWindowVisible
 *   随之把 'desktop' 档降级成"一直可见"。**绝不因为探测坏了就让桌宠消失**。
 *
 * 测试：scripts/tests/display-scope.test.mjs（纯解析部分 parseProbeLine）
 */

'use strict';

const { spawn } = require('node:child_process');

/** 解析一行探测输出：合法 JSON 且 className 是字符串才算数，其余（日志混入/半行/空行）返回 null */
function parseProbeLine(line) {
  const text = String(line == null ? '' : line).trim();
  if (!text || text.charAt(0) !== '{') return null;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj.className !== 'string') return null;
  // hwnd 用 Number 承载：Windows 句柄实际只用低 32 位，远在 Number 安全整数范围内
  const hwnd = Number(obj.hwnd);
  return {
    hwnd: Number.isFinite(hwnd) ? hwnd : 0,
    className: obj.className,
    title: typeof obj.title === 'string' ? obj.title : '',
  };
}

/**
 * 内嵌的 PowerShell 脚本。
 *
 * 结构：Add-Type 编译一小段 C# 拿 Win32 入口 → Register-ObjectEvent 把 WinEvent 回调转成
 * PowerShell 事件 → 主循环 Read-Host 阻塞等待。Event 动作在**主线程**上跑（PowerShell 把
 * 事件回调排在它的消息泵上），所以每条输出都是单线程串行写的，不会交错出半行 JSON。
 *
 * 已知取舍（都属于"降级成一直可见"，不影响正确性）：
 *   - PowerShell 需要能编译 C#（Windows PowerShell 5.1 自带 csc，实测可用）；
 *   - 中文标题经管道按 GBK 传出：本模块只用 className，标题仅供排障，乱码不影响判定。
 */
const PROBE_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DshPetForegroundProbe {
  public delegate void WinEventDelegate(IntPtr hWinEventHook, uint eventType, IntPtr hwnd,
    int idObject, int idChild, uint dwEventThread, uint dwmsEventTime);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax,
    IntPtr hmodWinEventProc, WinEventDelegate lpfnWinEventProc, uint idProcess, uint idThread, uint dwFlags);
  [DllImport("user32.dll")] public static extern bool UnhookWinEvent(IntPtr hWinEventHook);
  public static string Describe() {
    IntPtr h = GetForegroundWindow();
    var c = new StringBuilder(256); GetClassName(h, c, 256);
    var t = new StringBuilder(256); GetWindowText(h, t, 256);
    return "{\\"hwnd\\":" + h.ToInt64() + ",\\"className\\":\\"" + c.ToString().Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\"")
      + "\\",\\"title\\":\\"" + t.ToString().Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\"").Replace("\\r", " ").Replace("\\n", " ") + "\\"}";
  }
}
'@ -Language CSharp

  $desktopView = [IntPtr]::Zero
  # WINEVENT_OUTOFCONTEXT = 0x0000 | WINEVENT_SKIPOWNPROCESS = 0x0002
  $flags = 0x0002
  $cb = [DshPetForegroundProbe+WinEventDelegate]{
    param($hook, $type, $hwnd, $idObject, $idChild, $thread, $time)
    [Console]::Out.WriteLine([DshPetForegroundProbe]::Describe())
    [Console]::Out.Flush()
  }
  # EVENT_SYSTEM_FOREGROUND = 0x0003。**必须 min = max = 只得这一个事件**：
  # SetWinEventHook 的 eventMin..eventMax 是闭区间，写宽了会把整段区间里的事件全接下来
  # （实测把上界误写成 EVENT_OBJECT_NAMECHANGE(0x800C) 后，前台根本没变也会连报好几条——
  #  区间里包含着 EVENT_OBJECT_REORDER / LOCATIONCHANGE 这类极高频事件）。
  # 标题变化不单独挂钩：本模块只用 className 判定，标题仅供排障，新鲜度不值得再挂一个高频事件。
  $desktopView = [DshPetForegroundProbe]::SetWinEventHook(0x0003, 0x0003, [IntPtr]::Zero, $cb, 0, 0, $flags)
  if ($desktopView -eq [IntPtr]::Zero) { [Console]::Error.WriteLine('SetWinEventHook failed'); exit 4 }

  # 立刻报一次初始值，调用方不必等第一次切换才知道现状
  [Console]::Out.WriteLine([DshPetForegroundProbe]::Describe())
  [Console]::Out.Flush()
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 3
}

# 事件驱动：主线程阻塞在这里，事件回调排在 PowerShell 的消息泵上执行。
while ($true) { Start-Sleep -Milliseconds 500 }
`;

/** 探测的当前状态入口 */
const DEFAULT_OPTIONS = {
  /** 是否启用（非 win32 一律不启用——其余平台的桌面语义不同，本档位只在 Windows 生效） */
  enabled: process.platform === 'win32',
  /** powershell 可执行文件（Windows PowerShell 5.1 一定在；pwsh 不强求） */
  powershellPath: 'powershell.exe',
  /** 传给 powershell 的额外参数（测试可注入 -Command 等） */
  extraArgs: [],
};

/**
 * 起一条前台窗口探测通道。
 *
 * @param {object} options
 * @param {(state: {className: string, title: string}) => void} options.onState 前台变化回调
 * @param {(message: string) => void} [options.onWarn] 排障日志（stderr / 异常）
 * @returns {{stop: () => void, available: () => boolean}} 句柄；available() = 通道是否成功起来
 */
function startForegroundProbe(options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let child = null;
  let stopped = false;
  /** 通道是否已起来（真的收到过至少一行合法输出才算）——起不来时调用方按"探测不可用"降级 */
  let available = false;
  /** stdout 按行缓冲（半行不能丢，下次 data 接着拼） */
  let buffer = '';

  const warn = (message) => {
    if (typeof opts.onWarn === 'function') opts.onWarn(String(message));
  };

  if (!opts.enabled) {
    // 非 Windows：不 spawn，直接报"不可用"（decideWindowVisible 会把 desktop 档降级成一直可见）
    return { stop() {}, available: () => false };
  }

  try {
    child = spawn(
      opts.powershellPath,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PROBE_SCRIPT, ...opts.extraArgs],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    warn(`前台探测启动失败：${error instanceof Error ? error.message : String(error)}`);
    return { stop() {}, available: () => false };
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const state = parseProbeLine(line);
      if (!state) continue;
      if (!available) {
        available = true;
        warn('前台探测已就绪');
      }
      try {
        opts.onState(state);
      } catch (error) {
        warn(`前台探测回调异常：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    const line = String(chunk).trim();
    if (line) warn(`前台探测：${line}`);
  });
  child.on('error', (error) => {
    warn(`前台探测进程起不来：${error instanceof Error ? error.message : String(error)}`);
  });
  child.on('exit', (code, signal) => {
    available = false;
    // 主动 stop() 导致的退出不算异常，不刷日志
    if (stopped) return;
    warn(`前台探测进程退出（code=${String(code)}, signal=${String(signal)}）——desktop 档将降级为一直可见`);
  });

  return {
    stop() {
      stopped = true;
      available = false;
      try {
        child.kill();
      } catch {
        /* 已经退出了 */
      }
    },
    available: () => available,
  };
}

module.exports = { startForegroundProbe, parseProbeLine, PROBE_SCRIPT };
