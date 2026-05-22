// Runs inside an Electron utilityProcess - a clean Node child process,
// NOT the main process. The analysis pipeline (ffmpeg spawns + tesseract.js
// worker threads) hangs on the main process; here it gets a normal Node
// environment and keeps the UI responsive. One message in, one result out.
import { analyzeReel, type ReelAnalysisInput } from '../main/analyze';

// Electron exposes the parent channel as process.parentPort in a
// utilityProcess child; it isn't on the standard Node Process type.
const parentPort = (process as unknown as { parentPort: NodeJS.EventEmitter & {
  postMessage(msg: unknown): void;
} }).parentPort;

parentPort.on('message', async (e: { data: ReelAnalysisInput }) => {
  try {
    const result = await analyzeReel(e.data);
    parentPort.postMessage({ ok: true, result });
  } catch (err) {
    parentPort.postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
