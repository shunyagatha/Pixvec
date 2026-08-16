/**
 * Vecline for VS Code.
 *
 * Three commands on the explorer context menu for any raster image: convert to
 * SVG, convert to a framework component, or convert losslessly.
 *
 * The thing that makes this worth installing over a web converter is the last
 * line of every success message: the SSIM and PSNR of the conversion you just
 * did, measured by rendering the SVG back to pixels and comparing it with your
 * file. A converter that cannot tell you how close it got is asking you to
 * squint at the result and hope, and that is the habit this extension exists to
 * break — so the numbers are never optional here, even though they cost a render.
 */

import { basename, dirname, extname, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';

type Framework = 'react' | 'vue' | 'svelte' | 'solid';

/**
 * The slice of the engine this extension uses.
 *
 * Declared here rather than imported as `typeof import('vecline')` because the
 * engine is ESM and a VS Code extension host is CommonJS, so a type-only import
 * across that boundary needs a resolution mode. Naming the surface explicitly is
 * the better answer anyway: it is a contract of the four things the extension
 * depends on, so a change to anything else in the engine cannot silently alter
 * what this file compiles against.
 */
interface VeclineApi {
  loadRaster(path: string): Promise<LoadedImage>;
  vectorize(input: LoadedImage, opts?: VectorizeOpts): Promise<VectorizeResult>;
  toComponent(svg: string, opts: { framework: Framework; name?: string; currentColor?: boolean }): string;
}
interface LoadedImage { bytes: Uint8Array }
interface VectorizeOpts {
  preset?: string;
  mode?: string;
  verify?: boolean;
  /**
   * Progress and cancellation, forwarded to the tracer. Narrow on purpose, like
   * the rest of this contract: the extension depends on these two hooks and
   * nothing else in `TraceOptions`.
   */
  trace?: {
    onProgress?: (stage: string, pct: number) => void;
    signal?: { readonly aborted: boolean };
  };
}
interface VectorizeResult {
  svg: string;
  quality?: { ssim?: number; psnr?: number; lossless?: boolean };
}

/** File extension a component of each framework should be written to. */
const COMPONENT_EXT: Record<Framework, string> = {
  react: '.tsx',
  solid: '.tsx',
  vue: '.vue',
  svelte: '.svelte',
};

/** PascalCase, because every one of these frameworks requires it of a component. */
function componentName(file: string): string {
  const stem = basename(file, extname(file));
  const pascal = stem
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
  // A component name cannot start with a digit, and `Icon` is a better fallback
  // than a mangled one for a file called something like `2x-logo.png`.
  return /^[A-Za-z]/.test(pascal) ? pascal : `Icon${pascal}`;
}

/**
 * Report what was measured, not that it worked.
 *
 * `quality` is absent when verification did not run, and this says so rather
 * than printing a zero — an unmeasured result claiming 0.0000 would be worse
 * than one that admits it was not checked.
 */
function summarise(bytesIn: number, svg: string, quality: unknown): string {
  const q = quality as
    | { ssim?: number; psnr?: number; lossless?: boolean; exactRatio?: number }
    | undefined;
  const size = `${(bytesIn / 1024).toFixed(1)} KB → ${(svg.length / 1024).toFixed(1)} KB`;
  if (!q) return `${size} · not verified`;
  if (q.lossless) return `${size} · bit-exact (SSIM 1.0000, PSNR ∞, zero differing pixels)`;
  const ssim = typeof q.ssim === 'number' ? q.ssim.toFixed(4) : '—';
  const psnr = typeof q.psnr === 'number' && Number.isFinite(q.psnr) ? `${q.psnr.toFixed(1)} dB` : '∞';
  return `${size} · SSIM ${ssim} · PSNR ${psnr}`;
}

/** Write next to the source, never over it. */
async function writeBeside(source: vscode.Uri, ext: string, content: string): Promise<string> {
  const out = join(dirname(source.fsPath), `${basename(source.fsPath, extname(source.fsPath))}${ext}`);
  await writeFile(out, content, 'utf8');
  return out;
}

async function reveal(path: string): Promise<void> {
  if (!vscode.workspace.getConfiguration('vecline').get<boolean>('openAfterConvert', true)) return;
  const doc = await vscode.workspace.openTextDocument(path);
  await vscode.window.showTextDocument(doc, { preview: false });
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;

/**
 * Resolve the image to act on: the file that was right-clicked, or the active
 * tab when the command is run from the palette.
 *
 * The palette path used to read `window.activeTextEditor`, which can only ever
 * be a *text* editor. VS Code opens png/jpg/webp/gif/bmp in its built-in Image
 * Preview, a custom (webview) editor, so `activeTextEditor` was always
 * undefined for exactly the files these commands accept — the documented
 * palette path could never find an image, and every command was effectively
 * explorer-only.
 *
 * `tabGroups` sees every editor kind, so it finds the image the user is
 * actually looking at. The text-editor lookup stays as a fallback for the case
 * where an image is genuinely open as text.
 */
function targetUri(arg: vscode.Uri | undefined): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;

  const input = vscode.window.tabGroups.activeTabGroup?.activeTab?.input as
    | { uri?: vscode.Uri }
    | undefined;
  if (input?.uri instanceof vscode.Uri && IMAGE_EXT.test(input.uri.fsPath)) return input.uri;

  const active = vscode.window.activeTextEditor?.document.uri;
  return active && IMAGE_EXT.test(active.fsPath) ? active : undefined;
}

async function run(
  arg: vscode.Uri | undefined,
  label: string,
  convert: (
    api: VeclineApi,
    input: LoadedImage,
    // The source path, passed explicitly: `loadRaster` returns format and
    // dimensions but not where the file came from, so the caller is the only
    // thing that still knows the name a component should be derived from.
    path: string,
    // Forwarded to the engine so the notification can name the current stage
    // and the Cancel button can actually stop the work.
    progress?: { onProgress: (stage: string, pct: number) => void; signal: { readonly isCancellationRequested: boolean } },
  ) => Promise<{ out: string; ext: string; bytesIn: number; quality: unknown }>,
): Promise<void> {
  const uri = targetUri(arg);
  if (!uri) {
    void vscode.window.showErrorMessage('Vecline: right-click an image file, or open one, and try again.');
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Vecline: ${label} ${basename(uri.fsPath)}…`,
      // A lossless trace of a large image can take many seconds, and without
      // this there was no way to stop it once started.
      cancellable: true,
    },
    async (progress, token) => {
      try {
        // Imported lazily so activating the extension costs nothing until a
        // command actually runs — the engine pulls in codecs.
        const api = (await import('vecline')) as unknown as VeclineApi;

        // `progress` was previously not even destructured, so the notification
        // showed a static title and an indeterminate spinner from start to
        // finish. The engine reports named stages; forwarding them costs
        // nothing and turns "something is happening" into "it is tracing
        // contours".
        progress.report({ message: 'decoding' });
        const input = await api.loadRaster(uri.fsPath);

        const { out, ext, bytesIn, quality } = await convert(api, input, uri.fsPath, {
          // The percentage is deliberately dropped: VS Code's `increment` is a
          // delta, not an absolute, so feeding it stage percentages would make
          // the bar run past 100. The stage name is the useful half.
          onProgress: (stage: string) => progress.report({ message: stage.toLowerCase() }),
          signal: token,
        });
        const written = await writeBeside(uri, ext, out);
        void vscode.window.showInformationMessage(
          `Vecline → ${basename(written)}  ${summarise(bytesIn, out, quality)}`,
        );
        await reveal(written);
      } catch (err) {
        // Lossless failing is not a crash, it is the mode doing its job, so it
        // reads as a result rather than an error.
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Vecline: ${message}`);
      }
    },
  );
}

/**
 * Adapt VS Code's cancellation token to the engine's `signal` shape.
 *
 * `CancellationToken` exposes `isCancellationRequested`; the engine checks
 * `aborted`, so that it stays usable from a plain `AbortSignal` too.
 */
function traceHooks(
  p?: { onProgress: (stage: string, pct: number) => void; signal: { readonly isCancellationRequested: boolean } },
): { onProgress?: (stage: string, pct: number) => void; signal?: { readonly aborted: boolean } } | undefined {
  if (!p) return undefined;
  return {
    onProgress: p.onProgress,
    signal: { get aborted(): boolean { return p.signal.isCancellationRequested; } },
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const cfg = () => vscode.workspace.getConfiguration('vecline');

  context.subscriptions.push(
    vscode.commands.registerCommand('vecline.vectorize', (arg?: vscode.Uri) =>
      run(arg, 'converting', async (api, input, _path, p) => {
        const preset = cfg().get<string>('preset', 'auto');
        const r = await api.vectorize(input, {
          preset: preset === 'auto' ? undefined : (preset as never),
          verify: true,
          trace: traceHooks(p),
        });
        return { out: r.svg, ext: '.svg', bytesIn: input.bytes.length, quality: r.quality };
      })),

    vscode.commands.registerCommand('vecline.lossless', (arg?: vscode.Uri) =>
      run(arg, 'converting losslessly', async (api, input, _path, p) => {
        const r = await api.vectorize(input, { mode: 'lossless', verify: true, trace: traceHooks(p) });
        return { out: r.svg, ext: '.svg', bytesIn: input.bytes.length, quality: r.quality };
      })),

    vscode.commands.registerCommand('vecline.component', (arg?: vscode.Uri) =>
      run(arg, 'converting to a component', async (api, input, path, p) => {
        const framework = cfg().get<Framework>('framework', 'react');
        const preset = cfg().get<string>('preset', 'auto');
        const r = await api.vectorize(input, {
          preset: preset === 'auto' ? undefined : (preset as never),
          verify: true,
          trace: traceHooks(p),
        });
        const source = api.toComponent(r.svg, {
          framework,
          name: componentName(path),
          currentColor: cfg().get<boolean>('currentColor', true),
        });
        return {
          out: source,
          ext: COMPONENT_EXT[framework],
          bytesIn: input.bytes.length,
          quality: r.quality,
        };
      })),
  );
}

export function deactivate(): void {
  /* nothing to tear down: every command completes before it returns */
}
