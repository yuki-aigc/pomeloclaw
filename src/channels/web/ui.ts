import type { WebConfig } from '../../config.js';

function escapeAttribute(value: string): string {
    return value.replace(/"/g, '&quot;');
}

function toInlineJson(value: unknown): string {
    return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function renderWebChatPage(config: WebConfig): string {
    const boot = toInlineJson({
        title: config.title,
        wsPath: config.path,
        uiPath: config.uiPath,
        sessionApiPath: '/api/web/sessions',
        uploadApiPath: '/api/web/uploads',
        skillsApiPath: '/api/web/skills',
        authRequired: Boolean(config.authToken?.trim()),
    });

    return String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeAttribute(config.title)}</title>
  <style>
    :root {
      --bg-1: #f6efe2;
      --bg-2: #d8ebe5;
      --panel: rgba(252, 248, 241, 0.88);
      --panel-strong: rgba(255, 251, 246, 0.96);
      --ink: #17313a;
      --muted: #5f6f74;
      --accent: #c45e2b;
      --accent-2: #0d7d74;
      --accent-soft: rgba(196, 94, 43, 0.14);
      --line: rgba(23, 49, 58, 0.12);
      --shadow: 0 24px 70px rgba(25, 52, 56, 0.12);
      --radius: 24px;
      --font-ui: "IBM Plex Sans", "Noto Sans SC", "Segoe UI", sans-serif;
      --font-display: "Iowan Old Style", "Palatino Linotype", "Times New Roman", serif;
      --font-mono: "IBM Plex Mono", "SFMono-Regular", Consolas, monospace;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; }
    body {
      font-family: var(--font-ui);
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(196, 94, 43, 0.18), transparent 28%),
        radial-gradient(circle at right 15%, rgba(13, 125, 116, 0.18), transparent 24%),
        linear-gradient(135deg, var(--bg-1), var(--bg-2));
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background:
        linear-gradient(rgba(255,255,255,0.06) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,0.06) 1px, transparent 1px);
      background-size: 28px 28px;
      mask-image: linear-gradient(to bottom, rgba(0,0,0,0.35), transparent 70%);
    }
    .shell {
      max-width: 1320px;
      margin: 0 auto;
      padding: 28px 18px 24px;
      display: grid;
      grid-template-columns: 320px minmax(0, 1fr);
      gap: 18px;
      min-height: 100vh;
    }
    .panel {
      background: var(--panel);
      border: 1px solid rgba(255, 255, 255, 0.5);
      backdrop-filter: blur(18px);
      box-shadow: var(--shadow);
      border-radius: var(--radius);
    }
    .sidebar {
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 18px;
      animation: slide-up .45s ease-out;
    }
    .eyebrow {
      text-transform: uppercase;
      letter-spacing: 0.18em;
      font-size: 12px;
      color: var(--muted);
    }
    .hero {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .hero h1 {
      margin: 0;
      font-family: var(--font-display);
      font-size: clamp(32px, 4vw, 52px);
      line-height: 0.92;
      font-weight: 600;
    }
    .hero p {
      margin: 0;
      color: var(--muted);
      line-height: 1.6;
    }
    .status-card, .settings-card {
      padding: 16px 18px;
      border-radius: 18px;
      background: var(--panel-strong);
      border: 1px solid var(--line);
    }
    .status-card {
      display: grid;
      gap: 10px;
    }
    .status-line {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      font-size: 14px;
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: #c9ced1;
      box-shadow: 0 0 0 8px rgba(201, 206, 209, 0.18);
      transition: background .2s ease, box-shadow .2s ease;
    }
    .dot[data-state="connected"] {
      background: var(--accent-2);
      box-shadow: 0 0 0 8px rgba(13, 125, 116, 0.14);
    }
    .dot[data-state="connecting"] {
      background: #d28b35;
      box-shadow: 0 0 0 8px rgba(210, 139, 53, 0.14);
    }
    .mini {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }
    .settings-grid {
      display: grid;
      gap: 12px;
    }
    label {
      display: grid;
      gap: 6px;
      font-size: 13px;
      color: var(--muted);
    }
    input, textarea, button {
      font: inherit;
    }
    input, textarea {
      width: 100%;
      border: 1px solid rgba(23, 49, 58, 0.12);
      background: rgba(255, 255, 255, 0.8);
      color: var(--ink);
      padding: 12px 14px;
      border-radius: 14px;
      outline: none;
      transition: border-color .18s ease, transform .18s ease, background .18s ease;
    }
    input:focus, textarea:focus {
      border-color: rgba(13, 125, 116, 0.48);
      background: rgba(255, 255, 255, 0.96);
      transform: translateY(-1px);
    }
    .hidden {
      display: none !important;
    }
    .sidebar-actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    button {
      border: none;
      border-radius: 999px;
      padding: 12px 18px;
      cursor: pointer;
      transition: transform .18s ease, opacity .18s ease, box-shadow .18s ease;
    }
    button:hover { transform: translateY(-1px); }
    button:disabled { opacity: 0.55; cursor: not-allowed; transform: none; }
    .button-primary {
      color: #fff8ef;
      background: linear-gradient(135deg, var(--accent), #d67f4f);
      box-shadow: 0 14px 32px rgba(196, 94, 43, 0.22);
    }
    .button-secondary {
      color: var(--ink);
      background: rgba(255, 255, 255, 0.7);
      border: 1px solid var(--line);
    }
    .chat {
      display: grid;
      grid-template-rows: auto 1fr auto;
      min-height: calc(100vh - 48px);
      overflow: hidden;
      animation: slide-up .55s ease-out;
    }
    .chat-header {
      padding: 24px 26px 18px;
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .chat-title {
      display: grid;
      gap: 6px;
    }
    .chat-title h2 {
      margin: 0;
      font-size: 22px;
      font-weight: 600;
    }
    .chat-title p {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
    }
    .tool-chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 38px;
      padding: 0 14px;
      border-radius: 999px;
      background: rgba(13, 125, 116, 0.1);
      color: var(--accent-2);
      font-size: 13px;
      font-weight: 600;
    }
    .tool-chip::before {
      content: "";
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: currentColor;
      animation: pulse 1.4s infinite;
    }
    .messages {
      padding: 22px 24px;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 14px;
      scroll-behavior: smooth;
    }
    .empty-state {
      margin: auto;
      width: min(620px, 100%);
      padding: 28px;
      border-radius: 24px;
      background: rgba(255, 255, 255, 0.44);
      border: 1px dashed rgba(23, 49, 58, 0.18);
      display: grid;
      gap: 10px;
      text-align: center;
    }
    .empty-state h3 {
      margin: 0;
      font-family: var(--font-display);
      font-size: 28px;
      font-weight: 600;
    }
    .empty-state p {
      margin: 0;
      color: var(--muted);
      line-height: 1.6;
    }
    .message {
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-width: min(78ch, 100%);
      padding: 16px 18px;
      border-radius: 22px;
      border: 1px solid rgba(23, 49, 58, 0.08);
      background: rgba(255, 255, 255, 0.72);
      box-shadow: 0 12px 28px rgba(18, 42, 44, 0.06);
      animation: rise-in .24s ease-out;
    }
    .message[data-role="user"] {
      align-self: flex-end;
      background: linear-gradient(135deg, rgba(196, 94, 43, 0.16), rgba(255, 247, 239, 0.92));
      border-top-right-radius: 8px;
    }
    .message[data-role="assistant"] {
      align-self: flex-start;
      background: linear-gradient(135deg, rgba(13, 125, 116, 0.1), rgba(255, 255, 255, 0.94));
      border-top-left-radius: 8px;
    }
    .message[data-role="system"] {
      align-self: center;
      background: rgba(23, 49, 58, 0.08);
      color: var(--muted);
      max-width: 100%;
      text-align: center;
    }
    .message-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      font-size: 12px;
      color: var(--muted);
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .message-body {
      word-break: break-word;
      line-height: 1.72;
      font-size: 15px;
    }
    .message-body[data-render-mode="plain"] {
      white-space: pre-wrap;
    }
    .message-body p,
    .message-body ul,
    .message-body ol,
    .message-body blockquote,
    .message-body pre {
      margin: 0 0 12px;
    }
    .message-body p:last-child,
    .message-body ul:last-child,
    .message-body ol:last-child,
    .message-body blockquote:last-child,
    .message-body pre:last-child {
      margin-bottom: 0;
    }
    .message-body h1,
    .message-body h2,
    .message-body h3,
    .message-body h4 {
      margin: 0 0 12px;
      line-height: 1.2;
      font-family: var(--font-display);
      font-weight: 600;
    }
    .message-body h1 { font-size: 28px; }
    .message-body h2 { font-size: 24px; }
    .message-body h3 { font-size: 20px; }
    .message-body h4 { font-size: 17px; }
    .message-body ul,
    .message-body ol {
      padding-left: 20px;
    }
    .message-body li + li {
      margin-top: 6px;
    }
    .message-body blockquote {
      padding: 10px 14px;
      border-left: 3px solid rgba(13, 125, 116, 0.38);
      background: rgba(13, 125, 116, 0.08);
      border-radius: 0 14px 14px 0;
      color: #20494a;
    }
    .message-body a {
      color: var(--accent-2);
      text-decoration: none;
      border-bottom: 1px solid rgba(13, 125, 116, 0.24);
    }
    .message-body a:hover {
      border-bottom-color: rgba(13, 125, 116, 0.5);
    }
    .message-body .inline-code {
      display: inline-block;
      padding: 1px 7px;
      border-radius: 999px;
      background: rgba(23, 49, 58, 0.08);
      color: #7b2f15;
      font-family: var(--font-mono);
      font-size: 0.92em;
    }
    .message-body .code-block {
      overflow: hidden;
      padding: 0;
      border-radius: 18px;
      background: #18292f;
      color: #ecf5f2;
      border: 1px solid rgba(255, 255, 255, 0.06);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
    }
    .message-body .code-head {
      padding: 9px 14px;
      background: rgba(255, 255, 255, 0.05);
      color: rgba(236, 245, 242, 0.78);
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }
    .message-body .code-block code {
      display: block;
      padding: 14px 16px 16px;
      overflow-x: auto;
      white-space: pre;
      font-family: var(--font-mono);
      font-size: 13px;
      line-height: 1.72;
    }
    .message-body .token.comment { color: #86b7a7; }
    .message-body .token.keyword { color: #ffbd6f; }
    .message-body .token.string { color: #a7e48a; }
    .message-body .token.number { color: #7fd8ff; }
    .message-body .token.variable { color: #f6cf6c; }
    .message-body .token.type { color: #e4b7ff; }
    .message-attachments {
      display: grid;
      gap: 10px;
      margin-top: 4px;
    }
    .message-process {
      margin-top: 8px;
      border: 1px solid rgba(23, 49, 58, 0.12);
      background: rgba(255, 255, 255, 0.58);
      border-radius: 16px;
      overflow: hidden;
    }
    .message-process summary {
      list-style: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 14px;
      font-size: 13px;
      color: var(--muted);
      user-select: none;
    }
    .message-process summary::-webkit-details-marker {
      display: none;
    }
    .message-process-summary-title {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      color: var(--ink);
    }
    .message-process-summary-title::before {
      content: "▸";
      color: var(--accent-2);
      transition: transform .18s ease;
    }
    .message-process[open] .message-process-summary-title::before {
      transform: rotate(90deg);
    }
    .message-process-summary-meta {
      font-size: 12px;
      color: var(--muted);
    }
    .message-process-body {
      display: grid;
      gap: 10px;
      padding: 0 14px 14px;
      border-top: 1px solid rgba(23, 49, 58, 0.08);
    }
    .message-process-text {
      padding-top: 12px;
      white-space: pre-wrap;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.68;
    }
    .message-process-steps {
      display: grid;
      gap: 8px;
    }
    .message-process-step {
      padding: 9px 11px;
      border-radius: 12px;
      background: rgba(13, 125, 116, 0.08);
      color: #20494a;
      font-size: 13px;
      line-height: 1.55;
    }
    .attachment-card {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.72);
      border: 1px solid rgba(23, 49, 58, 0.1);
    }
    .attachment-meta {
      display: grid;
      gap: 2px;
      min-width: 0;
    }
    .attachment-name {
      font-size: 14px;
      font-weight: 600;
      color: var(--ink);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .attachment-note {
      color: var(--muted);
      font-size: 12px;
    }
    .attachment-link {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 86px;
      min-height: 38px;
      padding: 0 14px;
      border-radius: 999px;
      background: rgba(13, 125, 116, 0.12);
      color: var(--accent-2);
      text-decoration: none;
      font-weight: 600;
      border: 1px solid rgba(13, 125, 116, 0.14);
    }
    .attachment-link:hover {
      background: rgba(13, 125, 116, 0.16);
    }
    .message-body[data-streaming="true"]::after {
      content: "▋";
      display: inline-block;
      margin-left: 3px;
      color: var(--accent);
      animation: blink 1.1s steps(2, start) infinite;
    }
    .composer {
      padding: 18px 22px 22px;
      border-top: 1px solid var(--line);
      display: grid;
      gap: 12px;
      background: linear-gradient(180deg, rgba(255,255,255,0), rgba(255,255,255,0.32));
    }
    .composer textarea {
      min-height: 88px;
      max-height: 220px;
      resize: vertical;
      font-size: 15px;
      line-height: 1.6;
    }
    .composer-selected-skills {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .composer-selected-skills.hidden {
      display: none;
    }
    .skill-tag {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 34px;
      padding: 0 12px;
      border-radius: 999px;
      background: rgba(13, 125, 116, 0.1);
      border: 1px solid rgba(13, 125, 116, 0.14);
      color: var(--accent-2);
      font-size: 13px;
      font-weight: 600;
    }
    .skill-tag small {
      color: var(--muted);
      font-size: 12px;
      font-weight: 500;
    }
    .composer-mention {
      position: relative;
    }
    .mention-menu {
      position: absolute;
      left: 0;
      right: 0;
      bottom: calc(100% + 10px);
      display: grid;
      gap: 6px;
      padding: 10px;
      border-radius: 18px;
      border: 1px solid rgba(23, 49, 58, 0.1);
      background: rgba(255, 251, 246, 0.98);
      box-shadow: 0 18px 38px rgba(25, 52, 56, 0.12);
      max-height: 260px;
      overflow: auto;
      z-index: 5;
    }
    .mention-menu.hidden {
      display: none;
    }
    .mention-item {
      appearance: none;
      width: 100%;
      border: 1px solid transparent;
      background: rgba(255, 255, 255, 0.72);
      color: var(--ink);
      border-radius: 14px;
      padding: 10px 12px;
      display: grid;
      gap: 3px;
      text-align: left;
    }
    .mention-item:hover,
    .mention-item[data-active="true"] {
      border-color: rgba(13, 125, 116, 0.22);
      background: rgba(13, 125, 116, 0.08);
    }
    .mention-item strong {
      font-size: 14px;
      font-weight: 700;
    }
    .mention-item span {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.4;
    }
    .composer-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .composer-upload {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .button-ghost {
      appearance: none;
      border: 1px dashed rgba(23, 49, 58, 0.22);
      background: rgba(255, 255, 255, 0.6);
      color: var(--ink);
      border-radius: 999px;
      min-height: 42px;
      padding: 0 16px;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }
    .button-ghost:hover {
      background: rgba(255, 255, 255, 0.82);
    }
    .composer-files {
      display: grid;
      gap: 8px;
    }
    .composer-files.hidden {
      display: none;
    }
    .composer-file-card {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 12px;
      border-radius: 14px;
      border: 1px solid rgba(23, 49, 58, 0.1);
      background: rgba(255, 255, 255, 0.6);
    }
    .composer-file-meta {
      min-width: 0;
      display: grid;
      gap: 2px;
    }
    .composer-file-name {
      font-size: 14px;
      font-weight: 600;
      color: var(--ink);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .composer-file-note {
      color: var(--muted);
      font-size: 12px;
    }
    .composer-file-remove {
      appearance: none;
      border: 0;
      background: transparent;
      color: var(--accent);
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      padding: 4px 6px;
    }
    .composer-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .composer-tip {
      color: var(--muted);
      font-size: 13px;
    }
    .mono {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--muted);
      word-break: break-all;
    }
    @keyframes slide-up {
      from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes rise-in {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: .45; transform: scale(.78); }
    }
    @keyframes blink {
      0%, 49% { opacity: 1; }
      50%, 100% { opacity: 0; }
    }
    @media (max-width: 960px) {
      .shell {
        grid-template-columns: 1fr;
        padding: 14px;
      }
      .chat {
        min-height: calc(100vh - 24px);
      }
      .sidebar {
        padding: 18px;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="panel sidebar">
      <div class="hero">
        <div class="eyebrow">srebot Web Adapter</div>
        <h1>${escapeAttribute(config.title)}</h1>
        <p>直接复用后端 Agent、记忆与工具，浏览器通过 WebSocket 对话，并实时打印模型输出。</p>
      </div>

      <section class="status-card">
        <div class="status-line">
          <strong>连接状态</strong>
          <span class="dot" id="status-dot" data-state="disconnected"></span>
        </div>
        <div class="mini" id="status-text">未连接</div>
        <div class="mono" id="socket-url"></div>
      </section>

      <section class="settings-card">
        <div class="eyebrow" style="margin-bottom: 12px;">Session</div>
        <div class="settings-grid">
          <label>
            用户名
            <input id="user-name" maxlength="60" placeholder="例如：Hunter" />
          </label>
          <label>
            用户 ID
            <input id="user-id" maxlength="80" placeholder="例如：hunter" />
          </label>
          <label>
            会话 ID
            <input id="conversation-id" maxlength="120" />
          </label>
          <label id="token-wrap" class="${config.authToken?.trim() ? '' : 'hidden'}">
            Token
            <input id="auth-token" type="password" placeholder="如果服务端启用了 authToken，就填这里" />
          </label>
        </div>
        <div class="sidebar-actions" style="margin-top: 14px;">
          <button class="button-secondary" id="reconnect-button" type="button">重新连接</button>
          <button class="button-secondary" id="new-chat-button" type="button">新会话</button>
        </div>
      </section>
    </aside>

    <main class="panel chat">
      <header class="chat-header">
        <div class="chat-title">
          <h2>实时对话</h2>
          <p>流式事件：<code>reply_start</code> / <code>process_*</code> / <code>reply_final</code></p>
        </div>
        <div class="tool-chip hidden" id="tool-chip">正在调用工具</div>
      </header>

      <section class="messages" id="messages">
        <div class="empty-state" id="empty-state">
          <h3>把浏览器变成一个正式渠道</h3>
          <p>输入问题后，页面会通过 WebSocket 直接接收 Agent 的执行过程事件。最终完成时，服务端会补发一条 <code>reply_final</code> 做收尾校正。</p>
        </div>
      </section>

      <form class="composer" id="composer">
        <div class="composer-selected-skills hidden" id="selected-skills"></div>
        <div class="composer-mention">
          <div class="mention-menu hidden" id="skill-mention-menu"></div>
          <textarea id="prompt-input" placeholder="输入 @ 选择 skill，例如：@audit 帮我检查当前页面的可访问性问题。"></textarea>
        </div>
        <div class="composer-toolbar">
          <div class="composer-upload">
            <input id="attachment-input" type="file" multiple class="hidden" />
            <button class="button-ghost" id="attachment-button" type="button">上传图片/文件</button>
            <div class="composer-tip">可直接发送图片、文本文件、PDF、压缩包等附件。</div>
          </div>
        </div>
        <div class="composer-files hidden" id="composer-files"></div>
        <div class="composer-actions">
          <div class="composer-tip">Enter 发送，Shift + Enter 换行。</div>
          <button class="button-primary" id="send-button" type="submit">发送消息</button>
        </div>
      </form>
    </main>
  </div>

  <script>
    window.__POMELO_WEB_BOOT__ = ${boot};
  </script>
  <script>
    (() => {
      const boot = window.__POMELO_WEB_BOOT__;
      const els = {
        statusDot: document.getElementById('status-dot'),
        statusText: document.getElementById('status-text'),
        socketUrl: document.getElementById('socket-url'),
        userName: document.getElementById('user-name'),
        userId: document.getElementById('user-id'),
        conversationId: document.getElementById('conversation-id'),
        authToken: document.getElementById('auth-token'),
        toolChip: document.getElementById('tool-chip'),
        messages: document.getElementById('messages'),
        emptyState: document.getElementById('empty-state'),
        selectedSkills: document.getElementById('selected-skills'),
        skillMentionMenu: document.getElementById('skill-mention-menu'),
        promptInput: document.getElementById('prompt-input'),
        attachmentInput: document.getElementById('attachment-input'),
        attachmentButton: document.getElementById('attachment-button'),
        composerFiles: document.getElementById('composer-files'),
        composer: document.getElementById('composer'),
        sendButton: document.getElementById('send-button'),
        reconnectButton: document.getElementById('reconnect-button'),
        newChatButton: document.getElementById('new-chat-button')
      };

      const storageKeys = {
        userName: 'srebot.web.userName',
        userId: 'srebot.web.userId',
        conversationId: 'srebot.web.conversationId',
        authToken: 'srebot.web.authToken'
      };

      const state = {
        socket: null,
        isConnected: false,
        isBusy: false,
        connectionId: '',
        pendingReplies: new Map(),
        toolLabel: '',
        pendingUploads: [],
        availableSkills: [],
        mentionMatches: [],
        mentionQuery: null,
        activeMentionIndex: 0
      };

      function randomId(prefix) {
        return prefix + '-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8);
      }

      function loadField(key, fallback) {
        const value = localStorage.getItem(key);
        return value && value.trim() ? value : fallback;
      }

      function saveFields() {
        localStorage.setItem(storageKeys.userName, els.userName.value.trim());
        localStorage.setItem(storageKeys.userId, els.userId.value.trim());
        localStorage.setItem(storageKeys.conversationId, els.conversationId.value.trim());
        if (boot.authRequired) {
          localStorage.setItem(storageKeys.authToken, els.authToken.value);
        }
      }

      function getSocketUrl() {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        return protocol + '//' + location.host + boot.wsPath;
      }

      function buildAuthHeaders() {
        const headers = {};
        const token = boot.authRequired ? (els.authToken.value || '').trim() : '';
        if (token) {
          headers.Authorization = 'Bearer ' + token;
        }
        return headers;
      }

      async function loadAvailableSkills() {
        try {
          const response = await fetch(boot.skillsApiPath, {
            headers: buildAuthHeaders(),
            cache: 'no-store'
          });
          if (!response.ok) {
            if (response.status !== 401) {
              appendSystem('加载 skills 失败：HTTP ' + response.status);
            }
            return;
          }
          const payload = await response.json();
          state.availableSkills = Array.isArray(payload && payload.skills) ? payload.skills : [];
          syncSelectedSkillTags();
          refreshMentionMenu();
        } catch (error) {
          appendSystem('加载 skills 失败：' + (error && error.message ? error.message : String(error)));
        }
      }

      function setStatus(stateName, message) {
        els.statusDot.dataset.state = stateName;
        els.statusText.textContent = message;
      }

      function scrollMessages() {
        els.messages.scrollTop = els.messages.scrollHeight;
      }

      function removeEmptyState() {
        if (els.emptyState) {
          els.emptyState.remove();
        }
      }

      function getSkillAliases(skill) {
        const aliases = [];
        if (skill && typeof skill.name === 'string' && skill.name.trim()) {
          aliases.push(skill.name.trim().toLowerCase());
        }
        if (skill && typeof skill.dirName === 'string' && skill.dirName.trim()) {
          aliases.push(skill.dirName.trim().toLowerCase());
        }
        return Array.from(new Set(aliases));
      }

      function findSkillByAlias(alias) {
        const target = String(alias || '').trim().toLowerCase();
        if (!target) {
          return null;
        }
        return state.availableSkills.find((skill) => getSkillAliases(skill).includes(target)) || null;
      }

      function extractSelectedSkillsFromText(text) {
        const found = [];
        const seen = new Set();
        const pattern = /(^|\s)@([a-z0-9][a-z0-9_-]*)/gi;
        let match;
        while ((match = pattern.exec(text || ''))) {
          const skill = findSkillByAlias(match[2]);
          if (!skill || seen.has(skill.name)) {
            continue;
          }
          seen.add(skill.name);
          found.push(skill);
        }
        return found;
      }

      function syncSelectedSkillTags() {
        const selected = extractSelectedSkillsFromText(els.promptInput.value || '');
        els.selectedSkills.innerHTML = '';
        if (!selected.length) {
          els.selectedSkills.classList.add('hidden');
          return;
        }
        selected.forEach((skill) => {
          const tag = document.createElement('div');
          tag.className = 'skill-tag';
          tag.innerHTML = '<span>@' + escapeHtml(skill.name) + '</span><small>' + escapeHtml(skill.description || '') + '</small>';
          els.selectedSkills.appendChild(tag);
        });
        els.selectedSkills.classList.remove('hidden');
      }

      function getSkillMentionContext() {
        const value = els.promptInput.value || '';
        const cursor = typeof els.promptInput.selectionStart === 'number'
          ? els.promptInput.selectionStart
          : value.length;
        const beforeCursor = value.slice(0, cursor);
        const match = beforeCursor.match(/(?:^|\s)@([a-z0-9_-]*)$/i);
        if (!match) {
          return null;
        }
        return {
          query: (match[1] || '').toLowerCase(),
          replaceFrom: cursor - (match[1] || '').length - 1,
          replaceTo: cursor
        };
      }

      function getMentionMatches(query) {
        const normalized = String(query || '').trim().toLowerCase();
        const ranked = state.availableSkills.filter((skill) => {
          const haystacks = [
            String(skill.name || '').toLowerCase(),
            String(skill.dirName || '').toLowerCase(),
            String(skill.description || '').toLowerCase()
          ];
          if (!normalized) {
            return true;
          }
          return haystacks.some((item) => item.includes(normalized));
        });
        ranked.sort((a, b) => {
          const aStarts = String(a.name || '').toLowerCase().startsWith(normalized) ? 1 : 0;
          const bStarts = String(b.name || '').toLowerCase().startsWith(normalized) ? 1 : 0;
          if (aStarts !== bStarts) {
            return bStarts - aStarts;
          }
          return String(a.name || '').localeCompare(String(b.name || ''));
        });
        return ranked.slice(0, 8);
      }

      function closeMentionMenu() {
        state.mentionMatches = [];
        state.mentionQuery = null;
        state.activeMentionIndex = 0;
        els.skillMentionMenu.innerHTML = '';
        els.skillMentionMenu.classList.add('hidden');
      }

      function applySelectedSkill(skill) {
        const context = getSkillMentionContext();
        if (!context) {
          return;
        }
        const currentValue = els.promptInput.value || '';
        const insertion = '@' + skill.name + ' ';
        els.promptInput.value = currentValue.slice(0, context.replaceFrom) + insertion + currentValue.slice(context.replaceTo);
        const nextCursor = context.replaceFrom + insertion.length;
        els.promptInput.focus();
        els.promptInput.setSelectionRange(nextCursor, nextCursor);
        syncSelectedSkillTags();
        closeMentionMenu();
      }

      function refreshMentionMenu() {
        const context = getSkillMentionContext();
        if (!context || !state.availableSkills.length) {
          closeMentionMenu();
          return;
        }

        const matches = getMentionMatches(context.query);
        if (!matches.length) {
          closeMentionMenu();
          return;
        }

        state.mentionMatches = matches;
        state.mentionQuery = context.query;
        state.activeMentionIndex = Math.min(state.activeMentionIndex, matches.length - 1);
        els.skillMentionMenu.innerHTML = '';
        matches.forEach((skill, index) => {
          const item = document.createElement('button');
          item.type = 'button';
          item.className = 'mention-item';
          item.dataset.index = String(index);
          item.dataset.active = index === state.activeMentionIndex ? 'true' : 'false';
          item.innerHTML = '<strong>@' + escapeHtml(skill.name || '') + '</strong><span>' + escapeHtml(skill.description || '') + '</span>';
          item.addEventListener('mousedown', (event) => {
            event.preventDefault();
            applySelectedSkill(skill);
          });
          els.skillMentionMenu.appendChild(item);
        });
        els.skillMentionMenu.classList.remove('hidden');
      }

      function escapeHtml(value) {
        return String(value || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function sanitizeHref(url) {
        return /^https?:\/\//i.test(url) ? url : '#';
      }

      function formatBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes <= 0) {
          return '0 B';
        }
        var units = ['B', 'KB', 'MB', 'GB'];
        var value = bytes;
        var index = 0;
        while (value >= 1024 && index < units.length - 1) {
          value /= 1024;
          index += 1;
        }
        return (value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)) + ' ' + units[index];
      }

      function highlightSource(source, pattern, classify) {
        var output = '';
        var lastIndex = 0;
        source.replace(pattern, function(match, offset) {
          output += escapeHtml(source.slice(lastIndex, offset));
          output += '<span class="token ' + classify(match, offset, source) + '">' + escapeHtml(match) + '</span>';
          lastIndex = offset + match.length;
          return match;
        });
        output += escapeHtml(source.slice(lastIndex));
        return output;
      }

      function highlightCode(code, language) {
        var source = String(code || '');
        var lang = String(language || '').trim().toLowerCase();
        if (!source) {
          return '';
        }

        if (lang === 'ts' || lang === 'tsx' || lang === 'js' || lang === 'jsx' || lang === 'javascript' || lang === 'typescript') {
          return highlightSource(
            source,
            /(\/\/[^\n]*|"(?:\\.|[^"\n])*"|'(?:\\.|[^'\n])*'|\b(?:const|let|var|function|return|if|else|for|while|await|async|import|from|export|default|class|interface|type|extends|implements|new|try|catch|throw)\b|\b-?\d+(?:\.\d+)?\b)/g,
            function(token) {
              if (token.slice(0, 2) === '//') return 'comment';
              if (token.slice(0, 1) === '"' || token.slice(0, 1) === '\'') return 'string';
              if (/^-?\d/.test(token)) return 'number';
              if (/^(interface|type|class|extends|implements)$/.test(token)) return 'type';
              return 'keyword';
            }
          );
        }

        if (lang === 'json') {
          return highlightSource(
            source,
            /("(?:\\.|[^"\n])*"|\b(?:true|false|null)\b|\b-?\d+(?:\.\d+)?\b)/g,
            function(token, offset, fullText) {
              var tail = fullText.slice(offset + token.length);
              if (token.slice(0, 1) === '"' && /^\s*:/.test(tail)) return 'keyword';
              if (token.slice(0, 1) === '"') return 'string';
              if (/^-?\d/.test(token)) return 'number';
              return 'type';
            }
          );
        }

        if (lang === 'bash' || lang === 'sh' || lang === 'shell' || lang === 'zsh') {
          return highlightSource(
            source,
            /(#[^\n]*|\$\w+|\b(?:if|then|fi|for|in|do|done|case|esac|echo|export|local|function)\b|\b-?\d+(?:\.\d+)?\b)/g,
            function(token) {
              if (token.slice(0, 1) === '#') return 'comment';
              if (token.slice(0, 1) === '$') return 'variable';
              if (/^-?\d/.test(token)) return 'number';
              return 'keyword';
            }
          );
        }

        if (lang === 'sql') {
          return highlightSource(
            source,
            /(--[^\n]*|"(?:\\.|[^"\n])*"|'(?:\\.|[^'\n])*'|\b(?:select|from|where|join|left|right|inner|outer|group|by|order|limit|insert|into|update|delete|create|table|values|as|and|or|null)\b|\b-?\d+(?:\.\d+)?\b)/gi,
            function(token) {
              if (token.slice(0, 2) === '--') return 'comment';
              if (token.slice(0, 1) === '"' || token.slice(0, 1) === '\'') return 'string';
              if (/^-?\d/.test(token)) return 'number';
              return 'keyword';
            }
          );
        }

        if (lang === 'yaml' || lang === 'yml') {
          return highlightSource(
            source,
            /(#[^\n]*|\b(?:true|false|null|yes|no|on|off)\b|\b-?\d+(?:\.\d+)?\b|^[A-Za-z0-9_-]+(?=:\s))/gm,
            function(token) {
              if (token.slice(0, 1) === '#') return 'comment';
              if (/^-?\d/.test(token)) return 'number';
              if (/^(true|false|null|yes|no|on|off)$/i.test(token)) return 'type';
              return 'keyword';
            }
          );
        }

        return escapeHtml(source);
      }

      function renderCodeBlock(code, language) {
        var normalized = String(code || '').replace(/\n+$/, '');
        var label = String(language || '').trim() || 'text';
        return '<pre class="code-block"><div class="code-head">' + escapeHtml(label) + '</div><code>' +
          highlightCode(normalized, label) + '</code></pre>';
      }

      function renderInlineMarkdown(text) {
        var backtick = String.fromCharCode(96);
        var chunks = String(text || '').split(backtick);
        var placeholders = [];
        var value = '';
        var i;

        for (i = 0; i < chunks.length; i += 1) {
          if (i % 2 === 1) {
            value += '@@INLINECODE' + placeholders.length + '@@';
            placeholders.push('<code class="inline-code">' + escapeHtml(chunks[i]) + '</code>');
          } else {
            value += escapeHtml(chunks[i]);
          }
        }

        value = value.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function(_match, label, url) {
          return '<a href="' + sanitizeHref(url) + '" target="_blank" rel="noreferrer">' + label + '</a>';
        });
        value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        value = value.replace(/~~([^~]+)~~/g, '<del>$1</del>');

        for (i = 0; i < placeholders.length; i += 1) {
          value = value.replace('@@INLINECODE' + i + '@@', placeholders[i]);
        }

        return value;
      }

      function renderMarkdown(text) {
        var source = String(text || '').replace(/\r\n/g, '\n');
        if (!source.trim()) {
          return '<p>已处理，但没有可返回的文本结果。</p>';
        }

        var fence = String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96);
        var codeBlocks = [];
        var withPlaceholders = '';
        var cursor = 0;

        while (cursor < source.length) {
          var start = source.indexOf(fence, cursor);
          if (start < 0) {
            withPlaceholders += source.slice(cursor);
            break;
          }

          withPlaceholders += source.slice(cursor, start);
          var languageLineEnd = source.indexOf('\n', start + fence.length);
          var language = '';
          var codeStart = start + fence.length;
          if (languageLineEnd >= 0) {
            language = source.slice(start + fence.length, languageLineEnd).trim();
            codeStart = languageLineEnd + 1;
          } else {
            language = source.slice(start + fence.length).trim();
            codeStart = source.length;
          }

          var end = source.indexOf(fence, codeStart);
          var code = '';
          if (end < 0) {
            code = source.slice(codeStart);
            cursor = source.length;
          } else {
            code = source.slice(codeStart, end);
            cursor = end + fence.length;
          }

          withPlaceholders += '\n@@CODEBLOCK' + codeBlocks.length + '@@\n';
          codeBlocks.push(renderCodeBlock(code, language));
        }

        var lines = withPlaceholders.split('\n');
        var blocks = [];
        var paragraph = [];
        var listType = '';
        var listItems = [];

        function flushParagraph() {
          if (paragraph.length === 0) return;
          blocks.push('<p>' + renderInlineMarkdown(paragraph.join('<br />')) + '</p>');
          paragraph = [];
        }

        function flushList() {
          if (!listType || listItems.length === 0) {
            listType = '';
            listItems = [];
            return;
          }
          blocks.push('<' + listType + '><li>' + listItems.join('</li><li>') + '</li></' + listType + '>');
          listType = '';
          listItems = [];
        }

        for (var lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          var line = lines[lineIndex];
          var trimmed = line.trim();

          if (!trimmed) {
            flushParagraph();
            flushList();
            continue;
          }

          var codeMatch = trimmed.match(/^@@CODEBLOCK(\d+)@@$/);
          if (codeMatch) {
            flushParagraph();
            flushList();
            blocks.push(codeBlocks[Number(codeMatch[1])] || '');
            continue;
          }

          var headingMatch = trimmed.match(/^(#{1,4})\s+(.*)$/);
          if (headingMatch) {
            flushParagraph();
            flushList();
            blocks.push('<h' + headingMatch[1].length + '>' + renderInlineMarkdown(headingMatch[2]) + '</h' + headingMatch[1].length + '>');
            continue;
          }

          var quoteMatch = trimmed.match(/^>\s?(.*)$/);
          if (quoteMatch) {
            flushParagraph();
            flushList();
            blocks.push('<blockquote><p>' + renderInlineMarkdown(quoteMatch[1]) + '</p></blockquote>');
            continue;
          }

          var unorderedMatch = trimmed.match(/^[-*+]\s+(.*)$/);
          if (unorderedMatch) {
            flushParagraph();
            if (listType && listType !== 'ul') {
              flushList();
            }
            listType = 'ul';
            listItems.push(renderInlineMarkdown(unorderedMatch[1]));
            continue;
          }

          var orderedMatch = trimmed.match(/^\d+\.\s+(.*)$/);
          if (orderedMatch) {
            flushParagraph();
            if (listType && listType !== 'ol') {
              flushList();
            }
            listType = 'ol';
            listItems.push(renderInlineMarkdown(orderedMatch[1]));
            continue;
          }

          paragraph.push(trimmed);
        }

        flushParagraph();
        flushList();
        return blocks.join('');
      }

      function renderAttachments(container, attachments) {
        container.innerHTML = '';
        if (!Array.isArray(attachments) || attachments.length === 0) {
          container.classList.add('hidden');
          return;
        }

        attachments.forEach(function(attachment) {
          if (!attachment || !attachment.name) {
            return;
          }

          var card = document.createElement('div');
          card.className = 'attachment-card';

          var meta = document.createElement('div');
          meta.className = 'attachment-meta';

          var name = document.createElement('div');
          name.className = 'attachment-name';
          name.textContent = attachment.name;

          var note = document.createElement('div');
          note.className = 'attachment-note';
          note.textContent = (attachment.mimeType || 'application/octet-stream') + ' · ' + formatBytes(Number(attachment.sizeBytes || 0));

          meta.append(name, note);

          var link;
          if (attachment.url && attachment.url !== '#') {
            link = document.createElement('a');
            link.className = 'attachment-link';
            link.href = attachment.url;
            link.download = attachment.name;
            link.target = '_blank';
            link.rel = 'noreferrer';
            link.textContent = '下载';
          } else {
            link = document.createElement('span');
            link.className = 'attachment-link';
            link.textContent = '已上传';
          }

          card.append(meta, link);
          container.appendChild(card);
        });

        if (container.childElementCount > 0) {
          container.classList.remove('hidden');
        } else {
          container.classList.add('hidden');
        }
      }

      function renderPendingUploads() {
        els.composerFiles.innerHTML = '';
        if (!Array.isArray(state.pendingUploads) || state.pendingUploads.length === 0) {
          els.composerFiles.classList.add('hidden');
          return;
        }

        state.pendingUploads.forEach(function(file, index) {
          var card = document.createElement('div');
          card.className = 'composer-file-card';

          var meta = document.createElement('div');
          meta.className = 'composer-file-meta';

          var name = document.createElement('div');
          name.className = 'composer-file-name';
          name.textContent = file.name;

          var note = document.createElement('div');
          note.className = 'composer-file-note';
          note.textContent = (file.type || 'application/octet-stream') + ' · ' + formatBytes(file.size || 0);

          var removeButton = document.createElement('button');
          removeButton.className = 'composer-file-remove';
          removeButton.type = 'button';
          removeButton.textContent = '移除';
          removeButton.addEventListener('click', function() {
            state.pendingUploads.splice(index, 1);
            renderPendingUploads();
            syncComposerState();
          });

          meta.append(name, note);
          card.append(meta, removeButton);
          els.composerFiles.appendChild(card);
        });

        els.composerFiles.classList.remove('hidden');
      }

      function appendPendingFiles(fileList) {
        if (!fileList || fileList.length === 0) {
          return;
        }
        for (var i = 0; i < fileList.length; i += 1) {
          state.pendingUploads.push(fileList[i]);
        }
        renderPendingUploads();
        syncComposerState();
      }

      function clearPendingFiles() {
        state.pendingUploads = [];
        if (els.attachmentInput) {
          els.attachmentInput.value = '';
        }
        renderPendingUploads();
      }

      async function uploadPendingFiles() {
        if (!Array.isArray(state.pendingUploads) || state.pendingUploads.length === 0) {
          return [];
        }

        var formData = new FormData();
        formData.append('user_id', els.userId.value.trim() || 'web-user');
        if (els.conversationId.value.trim()) {
          formData.append('session_id', els.conversationId.value.trim());
        }
        state.pendingUploads.forEach(function(file) {
          formData.append('files', file, file.name);
        });

        var headers = {};
        if (boot.authRequired && els.authToken.value) {
          headers['authorization'] = 'Bearer ' + els.authToken.value;
        }

        var response = await fetch(boot.uploadApiPath, {
          method: 'POST',
          body: formData,
          headers: headers,
        });
        var payload = await response.json().catch(function() { return {}; });
        if (!response.ok || payload.ok === false) {
          throw new Error((payload.error && payload.error.message) || '附件上传失败');
        }
        return Array.isArray(payload.uploads) ? payload.uploads : [];
      }

      function createMessage(role, label, initialText, options) {
        removeEmptyState();

        const wrap = document.createElement('article');
        wrap.className = 'message';
        wrap.dataset.role = role;

        const head = document.createElement('div');
        head.className = 'message-head';

        const nameEl = document.createElement('span');
        nameEl.textContent = label;

        const timeEl = document.createElement('span');
        timeEl.textContent = new Date().toLocaleTimeString();

        const body = document.createElement('div');
        body.className = 'message-body';
        body.dataset.renderMode = options && options.rich ? 'rich' : 'plain';

        const attachments = document.createElement('div');
        attachments.className = 'message-attachments hidden';

        head.append(nameEl, timeEl);
        wrap.append(head, body, attachments);
        els.messages.appendChild(wrap);

        const record = {
          wrap: wrap,
          body: body,
          attachments: attachments,
          rawText: '',
          rich: Boolean(options && options.rich),
          hasProcess: false,
          process: null,
        };

        updateMessage(record, initialText || '', (options && options.attachments) || []);
        scrollMessages();
        return record;
      }

      function appendSystem(text) {
        createMessage('system', 'system', text, { rich: false });
      }

      function updateMessage(record, text, attachments) {
        record.rawText = text || '';
        if (record.rich) {
          record.body.innerHTML = renderMarkdown(record.rawText);
        } else {
          record.body.textContent = record.rawText;
        }
        renderAttachments(record.attachments, attachments);
      }

      function ensureReplyBubble(sourceMessageId) {
        let record = state.pendingReplies.get(sourceMessageId);
        if (record) return record;
        record = createMessage('assistant', 'assistant', '', { rich: true, attachments: [] });
        record.body.dataset.streaming = 'true';
        state.pendingReplies.set(sourceMessageId, record);
        return record;
      }

      function ensureProcessPanel(record, payload) {
        if (record.process) {
          if (payload && payload.title && record.process.summaryTitle.textContent !== payload.title) {
            record.process.summaryTitle.textContent = payload.title;
          }
          return record.process;
        }

        const details = document.createElement('details');
        details.className = 'message-process';

        const summary = document.createElement('summary');
        const summaryTitle = document.createElement('span');
        summaryTitle.className = 'message-process-summary-title';
        summaryTitle.textContent = (payload && payload.title) || '执行过程';

        const summaryMeta = document.createElement('span');
        summaryMeta.className = 'message-process-summary-meta';
        summaryMeta.textContent = (payload && payload.summary) || '进行中';

        summary.append(summaryTitle, summaryMeta);

        const body = document.createElement('div');
        body.className = 'message-process-body';

        const text = document.createElement('div');
        text.className = 'message-process-text hidden';

        const steps = document.createElement('div');
        steps.className = 'message-process-steps hidden';

        body.append(text, steps);
        details.append(summary, body);
        record.wrap.insertBefore(details, record.attachments);

        record.process = {
          details: details,
          summaryTitle: summaryTitle,
          summaryMeta: summaryMeta,
          text: text,
          steps: steps,
        };
        record.hasProcess = true;
        return record.process;
      }

      function renderProcessStepLine(step) {
        const toolName = step.tool_name || step.toolName || 'unknown';
        const preview = step.preview || step.summary || '';
        const prefix = step.step_type === 'tool_end' ? '工具完成' : '开始调用工具';
        return preview ? (prefix + '：' + toolName + ' · ' + preview) : (prefix + '：' + toolName);
      }

      function startProcess(sourceMessageId, payload) {
        const record = ensureReplyBubble(sourceMessageId);
        const process = ensureProcessPanel(record, payload || {});
        process.summaryMeta.textContent = (payload && payload.summary) || '进行中';
        return record;
      }

      function appendProcessDelta(sourceMessageId, payload) {
        const record = startProcess(sourceMessageId, payload);
        const process = ensureProcessPanel(record, payload);
        const delta = payload && payload.delta ? String(payload.delta) : '';
        if (!delta) {
          return;
        }
        process.text.classList.remove('hidden');
        process.text.textContent = (process.text.textContent || '') + delta;
        process.summaryMeta.textContent = '进行中';
        scrollMessages();
      }

      function appendProcessStep(sourceMessageId, payload) {
        const record = startProcess(sourceMessageId, payload);
        const process = ensureProcessPanel(record, payload);
        const line = renderProcessStepLine(payload || {});
        const step = document.createElement('div');
        step.className = 'message-process-step';
        step.textContent = line;
        process.steps.classList.remove('hidden');
        process.steps.appendChild(step);
        process.summaryMeta.textContent = '进行中';
        scrollMessages();
      }

      function finalizeProcess(record, payload) {
        if (!payload || !Array.isArray(payload.blocks) || payload.blocks.length === 0) {
          return;
        }
        const process = ensureProcessPanel(record, payload);
        process.summaryTitle.textContent = payload.title || '执行过程';
        process.summaryMeta.textContent = payload.summary || '执行完成';
        process.text.textContent = '';
        process.steps.innerHTML = '';

        if (payload.text) {
          process.text.classList.remove('hidden');
          process.text.textContent = payload.text;
        } else {
          process.text.classList.add('hidden');
        }

        let hasToolSteps = false;
        payload.blocks.forEach(function(block) {
          if (!block || block.type !== 'tool') {
            return;
          }
          hasToolSteps = true;
          const step = document.createElement('div');
          step.className = 'message-process-step';
          step.textContent = renderProcessStepLine({
            step_type: block.phase === 'end' ? 'tool_end' : 'tool_start',
            tool_name: block.toolName,
            preview: block.preview,
          });
          process.steps.appendChild(step);
        });

        if (hasToolSteps) {
          process.steps.classList.remove('hidden');
        } else {
          process.steps.classList.add('hidden');
        }
      }

      function finalizeReply(sourceMessageId, text, attachments, processPayload) {
        const record = ensureReplyBubble(sourceMessageId);
        record.body.dataset.streaming = 'false';
        updateMessage(record, text || '已处理，但没有可返回的文本结果。', attachments || []);
        if (processPayload) {
          finalizeProcess(record, processPayload);
        }
        state.pendingReplies.delete(sourceMessageId);
        state.isBusy = false;
        syncComposerState();
        scrollMessages();
      }

      function setToolChip(text) {
        state.toolLabel = text || '';
        if (!state.toolLabel) {
          els.toolChip.classList.add('hidden');
          els.toolChip.textContent = '正在调用工具';
          return;
        }
        els.toolChip.classList.remove('hidden');
        els.toolChip.textContent = state.toolLabel;
      }

      function syncComposerState() {
        const disabled = !state.isConnected || state.isBusy;
        els.sendButton.disabled = disabled;
        els.promptInput.disabled = disabled;
        els.attachmentButton.disabled = disabled;
      }

      function buildHelloPayload() {
        const userId = els.userId.value.trim() || 'web-user';
        const userName = els.userName.value.trim() || 'Web User';
        els.userId.value = userId;
        els.userName.value = userName;
        saveFields();

        return {
          type: 'hello',
          token: boot.authRequired ? els.authToken.value : undefined,
          client_id: 'web-ui',
          user_id: userId,
          nick_name: userName,
          session_id: els.conversationId.value.trim() || undefined,
          session_title: boot.title,
          isDirect: true
        };
      }

      function sendHello() {
        if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
          return;
        }
        state.socket.send(JSON.stringify(buildHelloPayload()));
      }

      function connect() {
        if (state.socket && (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING)) {
          return;
        }

        const socketUrl = getSocketUrl();
        els.socketUrl.textContent = socketUrl;
        setStatus('connecting', '连接中...');
        state.socket = new WebSocket(socketUrl);

        state.socket.addEventListener('open', () => {
          state.isConnected = true;
          setStatus('connected', '已连接');
          syncComposerState();
          sendHello();
        });

        state.socket.addEventListener('close', () => {
          state.isConnected = false;
          state.isBusy = false;
          state.connectionId = '';
          setToolChip('');
          setStatus('disconnected', '连接已关闭');
          syncComposerState();
        });

        state.socket.addEventListener('error', () => {
          setStatus('disconnected', '连接异常');
        });

        state.socket.addEventListener('message', (event) => {
          let payload;
          try {
            payload = JSON.parse(event.data);
          } catch {
            appendSystem('收到无法解析的服务端消息。');
            return;
          }

          switch (payload.type) {
            case 'hello_required':
              break;
            case 'hello_ack':
              state.connectionId = payload.connectionId || '';
              if (payload.session_id) {
                els.conversationId.value = payload.session_id;
                saveFields();
              }
              if (payload.authenticated === false) {
                setStatus('connecting', '等待认证');
              }
              break;
            case 'dispatch_ack':
              if (payload.status === 'error' && payload.reason) {
                appendSystem('消息分发失败：' + payload.reason);
                state.isBusy = false;
                syncComposerState();
              }
              break;
            case 'reply_start':
              ensureReplyBubble(payload.sourceMessageId);
              break;
            case 'process_start':
              startProcess(payload.sourceMessageId, payload);
              break;
            case 'process_delta':
              appendProcessDelta(payload.sourceMessageId, payload);
              break;
            case 'process_step':
              appendProcessStep(payload.sourceMessageId, payload);
              break;
            case 'reply_delta': {
              const record = ensureReplyBubble(payload.sourceMessageId);
              if (record.hasProcess) {
                break;
              }
              record.body.dataset.streaming = 'true';
              updateMessage(record, record.rawText + (payload.delta || ''), []);
              scrollMessages();
              break;
            }
            case 'reply_final':
              setToolChip('');
              finalizeReply(payload.sourceMessageId, payload.text || '', payload.attachments || [], payload.process || null);
              break;
            case 'reply_error':
              setToolChip('');
              finalizeReply(payload.sourceMessageId, '请求处理失败：' + (payload.message || '未知错误'), [], payload.process || null);
              break;
            case 'reply_cancelled':
              setToolChip('');
              finalizeReply(payload.sourceMessageId, (payload.text ? payload.text + '\n\n' : '') + '当前会话已中断。', [], payload.process || null);
              break;
            case 'cancel_ack':
              if (payload.status === 'not_found' || payload.status === 'error' || payload.status === 'unsupported') {
                appendSystem('中断请求失败：' + (payload.reason || payload.status || '未知错误'));
              }
              break;
            case 'session_state':
              break;
            case 'reply':
              finalizeReply(payload.messageId || randomId('reply'), payload.text || '', payload.attachments || []);
              break;
            case 'tool_start':
              setToolChip('正在调用工具：' + (payload.toolName || 'unknown'));
              break;
            case 'tool_end':
              setToolChip('');
              break;
            case 'proactive':
              createMessage('assistant', 'proactive', payload.text || '', { rich: true, attachments: payload.attachments || [] });
              break;
            case 'error':
              appendSystem(payload.message || '服务端返回错误。');
              break;
            case 'pong':
              break;
            default:
              appendSystem('收到未识别事件：' + payload.type);
          }
        });
      }

      async function sendMessage() {
        if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
          appendSystem('当前未连接到服务端。');
          return;
        }

        const text = els.promptInput.value.trim();
        const hasPendingUploads = Array.isArray(state.pendingUploads) && state.pendingUploads.length > 0;
        if ((!text && !hasPendingUploads) || state.isBusy) {
          return;
        }

        const sourceMessageId = randomId('msg');
        const conversationId = els.conversationId.value.trim() || undefined;
        const selectedSkills = extractSelectedSkillsFromText(text).map(function(skill) {
          return skill.name;
        });
        saveFields();

        state.isBusy = true;
        syncComposerState();
        var uploads = [];
        var userAttachments = [];

        try {
          uploads = await uploadPendingFiles();
          userAttachments = uploads.map(function(item) {
            return {
              name: item.name,
              url: '#',
              sizeBytes: item.sizeBytes,
              mimeType: item.mimeType
            };
          });

          createMessage('user', 'you', text || '（仅发送附件）', { rich: false, attachments: userAttachments });
          ensureReplyBubble(sourceMessageId);

          state.socket.send(JSON.stringify({
            type: 'message',
            message_id: sourceMessageId,
            request_id: sourceMessageId,
            idempotency_key: sourceMessageId,
            session_id: conversationId,
            session_title: boot.title,
            isDirect: true,
            user_id: els.userId.value.trim() || 'web-user',
            nick_name: els.userName.value.trim() || 'Web User',
            text,
            skills: selectedSkills,
            attachments: uploads.map(function(item) {
              return { upload_id: item.upload_id };
            })
          }));

          els.promptInput.value = '';
          clearPendingFiles();
        } catch (error) {
          appendSystem('附件上传失败：' + (error && error.message ? error.message : String(error)));
          state.isBusy = false;
          syncComposerState();
        }
      }

      function resetConversation() {
        els.conversationId.value = '';
        saveFields();
        els.messages.innerHTML = '';
        els.messages.appendChild(els.emptyState || document.createElement('div'));
        location.reload();
      }

      els.userName.value = loadField(storageKeys.userName, 'Web User');
      els.userId.value = loadField(storageKeys.userId, 'web-user');
      els.conversationId.value = loadField(storageKeys.conversationId, '');
      if (boot.authRequired) {
        els.authToken.value = loadField(storageKeys.authToken, '');
      }

      els.composer.addEventListener('submit', (event) => {
        event.preventDefault();
        void sendMessage();
      });

      els.promptInput.addEventListener('keydown', (event) => {
        if (!els.skillMentionMenu.classList.contains('hidden') && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
          event.preventDefault();
          if (!state.mentionMatches.length) {
            return;
          }
          const delta = event.key === 'ArrowDown' ? 1 : -1;
          state.activeMentionIndex = (state.activeMentionIndex + delta + state.mentionMatches.length) % state.mentionMatches.length;
          refreshMentionMenu();
          return;
        }
        if (!els.skillMentionMenu.classList.contains('hidden') && event.key === 'Enter' && !event.shiftKey) {
          const activeSkill = state.mentionMatches[state.activeMentionIndex];
          if (activeSkill) {
            event.preventDefault();
            applySelectedSkill(activeSkill);
            return;
          }
        }
        if (event.key === 'Escape') {
          closeMentionMenu();
          return;
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          void sendMessage();
        }
      });

      els.promptInput.addEventListener('input', () => {
        syncSelectedSkillTags();
        refreshMentionMenu();
      });

      els.promptInput.addEventListener('click', () => {
        refreshMentionMenu();
      });

      els.promptInput.addEventListener('blur', () => {
        setTimeout(() => {
          closeMentionMenu();
        }, 120);
      });

      els.attachmentButton.addEventListener('click', () => {
        if (!els.attachmentInput.disabled) {
          els.attachmentInput.click();
        }
      });

      els.attachmentInput.addEventListener('change', () => {
        appendPendingFiles(Array.from(els.attachmentInput.files || []));
      });

      [els.userName, els.userId, els.conversationId, els.authToken].forEach((input) => {
        if (!input) return;
        input.addEventListener('change', () => {
          saveFields();
          void loadAvailableSkills();
          if (state.isConnected) {
            sendHello();
          }
        });
      });

      els.reconnectButton.addEventListener('click', () => {
        if (state.socket) {
          try { state.socket.close(); } catch {}
        }
        connect();
      });

      els.newChatButton.addEventListener('click', () => {
        localStorage.removeItem(storageKeys.conversationId);
        resetConversation();
      });

      setStatus('disconnected', '未连接');
      els.socketUrl.textContent = getSocketUrl();
      syncComposerState();
      renderPendingUploads();
      syncSelectedSkillTags();
      void loadAvailableSkills();
      connect();
      setInterval(() => {
        if (state.socket && state.socket.readyState === WebSocket.OPEN) {
          state.socket.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
        }
      }, 15000);
    })();
  </script>
</body>
</html>`;
}
