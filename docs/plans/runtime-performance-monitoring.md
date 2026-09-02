# opencode-gui 运行时性能数据采集方案

## 1. 背景与目标

在 AI 对话特别多的场景下（长对话、频繁流式更新），需要采集以下运行时性能数据：

| 指标 | 说明 |
|------|------|
| **JS Heap 使用量** | 前端内存占用，检测内存泄漏 |
| **DOM 节点数** | 消息列表渲染导致的 DOM 膨胀 |
| **帧率 (FPS)** | 主线程卡顿检测 |
| **长任务** | 超过 50ms 的阻塞任务 |
| **关键路径耗时** | 消息处理、JSON.parse、流式更新等 |

## 2. 现状分析

| 能力 | 状态 | 说明 |
|------|------|------|
| CPU/计时 | 部分存在 | `perfTimer()` 仅在开发模式下测量 5 个输入操作 |
| 内存监控 | **不存在** | 无 `performance.memory` 使用 |
| 帧率监控 | 间接存在 | 心跳中有 RAF 数据，未暴露 |
| 生产性能日志 | **不存在** | console 被静默，无遥测上报 |
| Bundle 分析 | 不存在 | 无 analyzer 工具 |

## 3. 采集方案

### 3.1 新建性能监控模块

**文件**: `webview/src/utils/performanceMonitor.ts`

```typescript
/**
 * 运行时性能监控模块
 *
 * 采集指标：
 * - JS Heap 使用量 (performance.memory)
 * - DOM 节点数
 * - 帧率 (FPS)
 * - 长任务 (PerformanceObserver)
 * - 关键路径耗时 (performance.mark/measure)
 */

interface PerformanceSnapshot {
  timestamp: number;
  memory: {
    usedJSHeapSize: number;    // bytes
    jsHeapSizeLimit: number;   // bytes
  };
  dom: {
    nodeCount: number;
  };
  fps: {
    current: number;
    min: number;
    max: number;
  };
  longTasks: {
    count: number;
    totalDuration: number;     // ms
  };
}

interface TimingEntry {
  name: string;
  duration: number;            // ms
  timestamp: number;
}

class PerformanceMonitor {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private snapshots: PerformanceSnapshot[] = [];
  private timings: TimingEntry[] = [];
  private longTaskCount = 0;
  private longTaskTotalDuration = 0;
  private fpsHistory: number[] = [];
  private rafId: number | null = null;

  // 配置
  private readonly SAMPLE_INTERVAL_MS = 5000;  // 5 秒采样
  private readonly MAX_SNAPSHOTS = 100;        // 最多保留 100 个快照
  private readonly LONG_TASK_THRESHOLD_MS = 50;

  /**
   * 启动监控
   */
  start(): void {
    this.setupLongTaskObserver();
    this.startFpsTracking();
    this.startMemorySampling();
  }

  /**
   * 停止监控
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /**
   * 获取当前快照
   */
  getSnapshot(): PerformanceSnapshot {
    return {
      timestamp: Date.now(),
      memory: this.getMemoryUsage(),
      dom: { nodeCount: document.querySelectorAll('*').length },
      fps: this.getFpsStats(),
      longTasks: {
        count: this.longTaskCount,
        totalDuration: this.longTaskTotalDuration,
      },
    };
  }

  /**
   * 获取所有历史快照
   */
  getSnapshots(): PerformanceSnapshot[] {
    return [...this.snapshots];
  }

  /**
   * 获取关键路径耗时记录
   */
  getTimings(): TimingEntry[] {
    return [...this.timings];
  }

  /**
   * 记录关键路径耗时
   */
  mark(name: string): void {
    performance.mark(`perfmon:${name}:start`);
  }

  measure(name: string): void {
    const startMark = `perfmon:${name}:start`;
    const endMark = `perfmon:${name}:end`;
    performance.mark(endMark);

    try {
      const measure = performance.measure(name, startMark, endMark);
      this.timings.push({
        name,
        duration: measure.duration,
        timestamp: Date.now(),
      });

      // 限制记录数量
      if (this.timings.length > 1000) {
        this.timings = this.timings.slice(-500);
      }
    } catch {
      // 忽略测量错误
    } finally {
      performance.clearMarks(startMark);
      performance.clearMarks(endMark);
    }
  }

  /**
   * 导出数据为 JSON
   */
  exportData(): void {
    const data = {
      snapshots: this.snapshots,
      timings: this.timings,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `perf-data-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // === 私有方法 ===

  private getMemoryUsage() {
    // performance.memory 仅在部分浏览器/环境中可用
    const memory = (performance as any).memory;
    return {
      usedJSHeapSize: memory?.usedJSHeapSize ?? 0,
      jsHeapSizeLimit: memory?.jsHeapSizeLimit ?? 0,
    };
  }

  private getFpsStats() {
    if (this.fpsHistory.length === 0) {
      return { current: 0, min: 0, max: 0 };
    }
    return {
      current: this.fpsHistory[this.fpsHistory.length - 1],
      min: Math.min(...this.fpsHistory),
      max: Math.max(...this.fpsHistory),
    };
  }

  private setupLongTaskObserver(): void {
    if (typeof PerformanceObserver === 'undefined') return;

    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration > this.LONG_TASK_THRESHOLD_MS) {
            this.longTaskCount++;
            this.longTaskTotalDuration += entry.duration;

            console.warn(`[PerfMon] Long task: ${entry.duration.toFixed(1)}ms`, entry);
          }
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
    } catch {
      // longtask 不被支持时静默失败
    }
  }

  private startFpsTracking(): void {
    let frameCount = 0;
    let lastTime = performance.now();

    const tick = (now: number) => {
      frameCount++;

      if (now - lastTime >= 1000) {
        const fps = Math.round((frameCount * 1000) / (now - lastTime));
        this.fpsHistory.push(fps);

        // 保留最近 60 个 FPS 采样点
        if (this.fpsHistory.length > 60) {
          this.fpsHistory.shift();
        }

        frameCount = 0;
        lastTime = now;
      }

      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  private startMemorySampling(): void {
    this.intervalId = setInterval(() => {
      const snapshot = this.getSnapshot();
      this.snapshots.push(snapshot);

      // 限制快照数量
      if (this.snapshots.length > this.MAX_SNAPSHOTS) {
        this.snapshots = this.snapshots.slice(-this.MAX_SNAPSHOTS / 2);
      }

      // 开发模式下输出到控制台
      if (import.meta.env.DEV) {
        console.log('[PerfMon] Snapshot:', {
          memory: `${(snapshot.memory.usedJSHeapSize / 1024 / 1024).toFixed(1)} MB`,
          dom: snapshot.dom.nodeCount,
          fps: snapshot.fps.current,
          longTasks: snapshot.longTasks.count,
        });
      }
    }, this.SAMPLE_INTERVAL_MS);
  }
}

// 单例导出
export const perfMonitor = new PerformanceMonitor();
```

### 3.2 调试面板组件

**文件**: `webview/src/components/DebugPanel.tsx`

```tsx
import { useState, useEffect } from 'react';
import { perfMonitor } from '../utils/performanceMonitor';

export function DebugPanel() {
  const [snapshot, setSnapshot] = useState(perfMonitor.getSnapshot());
  const [timings, setTimings] = useState(perfMonitor.getTimings());
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setSnapshot(perfMonitor.getSnapshot());
      setTimings(perfMonitor.getTimings().slice(-20)); // 最近 20 条
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  if (!visible) {
    return (
      <button
        onClick={() => setVisible(true)}
        style={{
          position: 'fixed',
          bottom: 80,
          right: 16,
          background: 'rgba(0,0,0,0.7)',
          color: '#0f0',
          border: 'none',
          padding: '4px 8px',
          borderRadius: 4,
          fontSize: 11,
          fontFamily: 'monospace',
          zIndex: 9999,
          cursor: 'pointer',
        }}
      >
        Perf
      </button>
    );
  }

  return (
    <div style={{
      position: 'fixed',
      bottom: 80,
      right: 16,
      background: 'rgba(0,0,0,0.85)',
      color: '#0f0',
      padding: 12,
      borderRadius: 8,
      fontSize: 12,
      fontFamily: 'monospace',
      zIndex: 9999,
      minWidth: 280,
      maxHeight: 400,
      overflow: 'auto',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontWeight: 'bold' }}>Performance Monitor</span>
        <button
          onClick={() => setVisible(false)}
          style={{ background: 'none', border: 'none', color: '#0f0', cursor: 'pointer' }}
        >
          ×
        </button>
      </div>

      <div>Memory: {formatBytes(snapshot.memory.usedJSHeapSize)}</div>
      <div>DOM Nodes: {snapshot.dom.nodeCount.toLocaleString()}</div>
      <div>FPS: {snapshot.fps.current} (min: {snapshot.fps.min}, max: {snapshot.fps.max})</div>
      <div>Long Tasks: {snapshot.longTasks.count} ({snapshot.longTasks.totalDuration.toFixed(0)}ms total)</div>

      <div style={{ marginTop: 8, fontWeight: 'bold' }}>Recent Timings:</div>
      {timings.length === 0 && <div style={{ color: '#888' }}>No data yet...</div>}
      {timings.map((t, i) => (
        <div key={i} style={{ color: t.duration > 50 ? '#f44' : t.duration > 16 ? '#ff0' : '#0f0' }}>
          {t.name}: {t.duration.toFixed(1)}ms
        </div>
      ))}

      <button
        onClick={() => perfMonitor.exportData()}
        style={{
          marginTop: 8,
          background: '#333',
          color: '#0f0',
          border: '1px solid #0f0',
          padding: '4px 8px',
          borderRadius: 4,
          cursor: 'pointer',
          fontSize: 11,
        }}
      >
        Export JSON
      </button>
    </div>
  );
}
```

### 3.3 关键路径埋点

#### 3.3.1 消息处理耗时

**文件**: `webview/src/hooks/windowCallbacks/registerCallbacks/messageCallbacks.ts`

在 `processUpdateMessages` 函数前后添加：

```typescript
import { perfMonitor } from '../../../utils/performanceMonitor';

function processUpdateMessages(...) {
  perfMonitor.mark('processUpdateMessages');

  // ... 原有逻辑 ...

  perfMonitor.measure('processUpdateMessages');
}
```

#### 3.3.2 JSON.parse 耗时

**文件**: `webview/src/hooks/windowCallbacks/registerCallbacks/messageCallbacks.ts`

```typescript
// 在 JSON.parse 调用处
perfMonitor.mark('jsonParse');
const parsed = JSON.parse(json);
perfMonitor.measure('jsonParse');
```

#### 3.3.3 流式 patch 耗时

**文件**: `webview/src/hooks/useStreamingMessages.ts`

```typescript
import { perfMonitor } from '../utils/performanceMonitor';

function patchAssistantForStreaming(...) {
  perfMonitor.mark('patchAssistantForStreaming');

  // ... 原有逻辑 ...

  perfMonitor.measure('patchAssistantForStreaming');
}
```

#### 3.3.4 消息列表渲染耗时

**文件**: `webview/src/components/MessageList.tsx`

```typescript
import { perfMonitor } from '../utils/performanceMonitor';

// 在 visibleMessages.map 之前
perfMonitor.mark('renderMessageList');

// 在 map 之后
perfMonitor.measure('renderMessageList');
```

## 4. 数据导出

### 4.1 控制台导出

```typescript
// 在控制台执行
window.__perfMonitor = perfMonitor;

// 获取所有快照
console.table(perfMonitor.getSnapshots());

// 获取所有耗时记录
console.table(perfMonitor.getTimings());

// 导出为 JSON
perfMonitor.exportData();
```

### 4.2 localStorage 持久化

```typescript
// 在监控模块中添加
localStorage.setItem('perfMonitorData', JSON.stringify({
  snapshots: this.snapshots,
  timings: this.timings,
}));
```

## 5. 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `webview/src/utils/performanceMonitor.ts` | **新建** | 核心监控模块 |
| `webview/src/components/DebugPanel.tsx` | **新建** | 调试面板组件 |
| `webview/src/main.tsx` | **修改** | 启动监控 + 渲染 DebugPanel |
| `webview/src/hooks/windowCallbacks/registerCallbacks/messageCallbacks.ts` | **修改** | 消息处理埋点 |
| `webview/src/hooks/useStreamingMessages.ts` | **修改** | 流式 patch 埋点 |
| `webview/src/components/MessageList.tsx` | **修改** | 渲染耗时埋点 |

## 6. 使用方式

1. **开发模式**: 自动启动监控，右下角显示调试面板
2. **生产模式**: 默认关闭，通过 `localStorage.setItem('enablePerfMonitor', 'true')` 启用
3. **数据导出**: 在控制台执行 `window.__perfMonitor.exportData()` 下载 JSON
4. **场景复现**: 在特定操作前后调用 `perfMonitor.mark('场景名')` 标记

## 7. 预期输出示例

```json
{
  "snapshots": [
    {
      "timestamp": 1700000000000,
      "memory": { "usedJSHeapSize": 52428800, "jsHeapSizeLimit": 2147483648 },
      "dom": { "nodeCount": 3245 },
      "fps": { "current": 60, "min": 58, "max": 60 },
      "longTasks": { "count": 2, "totalDuration": 125 }
    }
  ],
  "timings": [
    { "name": "processUpdateMessages", "duration": 45.2, "timestamp": 1700000001000 },
    { "name": "jsonParse", "duration": 12.8, "timestamp": 1700000001001 },
    { "name": "patchAssistantForStreaming", "duration": 8.5, "timestamp": 1700000001002 }
  ]
}
```
