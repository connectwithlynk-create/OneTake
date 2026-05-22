import { app, BrowserWindow, ipcMain, utilityProcess } from 'electron';
import { join } from 'path';
import type { ReelAnalysisInput } from './analyze';
import { resolveReel } from './resolver';

// Analysis (ffmpeg + tesseract.js worker threads) hangs when run on the
// main process. Run it in a utilityProcess - a clean Node child - and
// relay the result. Also keeps the UI responsive during the ~20-40s job.
function runAnalysis(input: ReelAnalysisInput): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(join(__dirname, 'analyzer.js'));
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      fn();
    };
    timer = setTimeout(
      () => finish(() => reject(new Error('analysis timed out'))),
      180_000,
    );
    child.on(
      'message',
      (msg: { ok: boolean; result?: unknown; error?: string }) => {
        finish(() =>
          msg?.ok
            ? resolve(msg.result)
            : reject(new Error(msg?.error ?? 'analysis failed')),
        );
      },
    );
    child.on('exit', (code) => {
      finish(() => reject(new Error(`analyzer exited (code ${code})`)));
    });
    child.on('spawn', () => child.postMessage(input));
  });
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0d0d0f',
    title: 'OneTake',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  });

  // electron-vite sets ELECTRON_RENDERER_URL in dev (Vite dev server);
  // in a packaged build it's absent and we load the built HTML.
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  ipcMain.handle('resolve-reel', (_e, url: string) => resolveReel(url));
  ipcMain.handle('analyze-reel', (_e, input: ReelAnalysisInput) =>
    runAnalysis(input),
  );

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
