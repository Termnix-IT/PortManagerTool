// アプリアイコン（build/icon.png, 512x512）を生成する。
// 画像編集ツールに依存しないよう、Electron でSVGを描画してPNGとして書き出す。
// 実行: npm run icon
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZE = 512;

const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#26324a"/>
      <stop offset="1" stop-color="#151a24"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7cb2ff"/>
      <stop offset="1" stop-color="#3d7bf0"/>
    </linearGradient>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="104" fill="url(#bg)"/>
  <rect x="16.5" y="16.5" width="479" height="479" rx="103.5" fill="none" stroke="#ffffff" stroke-opacity="0.08"/>
  <!-- ソケット（ポート） -->
  <rect x="136" y="150" width="240" height="172" rx="36" fill="none" stroke="url(#accent)" stroke-width="28"/>
  <rect x="196" y="206" width="30" height="60" rx="10" fill="url(#accent)"/>
  <rect x="286" y="206" width="30" height="60" rx="10" fill="url(#accent)"/>
  <!-- 状態インジケーター -->
  <!-- 幅0の直線はオブジェクト基準のグラデーションが描画されないため単色にする -->
  <path d="M256 322 V372" stroke="#4f8bf5" stroke-width="28" stroke-linecap="round"/>
  <circle cx="256" cy="398" r="24" fill="#4ade80"/>
</svg>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    paintWhenInitiallyHidden: true,
  });
  const html = `<html><body style="margin:0;background:transparent">${SVG}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((resolve) => setTimeout(resolve, 300));

  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  const png = image.resize({ width: SIZE, height: SIZE }).toPNG();
  const outDir = path.join(__dirname, '..', 'build');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'icon.png'), png);
  console.log(`wrote build/icon.png (${image.getSize().width}x${image.getSize().height} -> ${SIZE}x${SIZE}, ${png.length} bytes)`);
  app.quit();
}).catch((err) => {
  console.error('アイコンの生成に失敗しました:', err);
  app.exit(1);
});
