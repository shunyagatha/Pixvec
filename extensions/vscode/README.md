# Vecline for VS Code

Right-click a PNG or JPEG in the explorer and get an SVG — **and the numbers that
say how close it is**.

```
Vecline → logo.svg   94.5 KB → 21.0 KB · bit-exact (SSIM 1.0000, PSNR ∞, zero differing pixels)
```

Every conversion is verified the way [Vecline](https://github.com/shunyagatha/Vecline)
verifies everything: the SVG it just produced is rendered back to pixels with the
same renderer a browser uses, and compared against your file. The SSIM and PSNR in
that message are measured from the actual output, not estimated from the settings.

## Commands

Right-click any `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif` or `.bmp`:

| Command | What it writes |
|---|---|
| **Convert to SVG** | `name.svg`, traced with your chosen preset |
| **Convert to Component** | `Name.tsx` / `.vue` / `.svelte`, ready to import |
| **Convert to SVG (lossless, or fail)** | `name.svg` that is bit-exact — or an error, never a silent near-miss |

All three also work from the command palette when an image is the active editor.

## Why the lossless command can fail

That is the point of it. A converter that returns *something* no matter what
leaves you to notice the damage yourself. Lossless mode renders every candidate
and refuses to return one that is not pixel-identical, so a success is a
guarantee rather than a hope.

## Settings

| Setting | Default | |
|---|---|---|
| `vecline.preset` | `auto` | `auto` inspects the image and picks. Or force `logo`, `lineart`, `poster`, `photo`, `detailed`, `pixelart` |
| `vecline.framework` | `react` | Target for **Convert to Component** — also `vue`, `svelte`, `solid` |
| `vecline.currentColor` | `true` | Map solid fills to `currentColor` so CSS `color` drives them. Gradients are left alone |
| `vecline.openAfterConvert` | `true` | Open the generated file when it is written |

## What it does not do

- **It never overwrites your image.** Output is always written beside the source.
- **Photographs are approximated, and it tells you so.** Tracing a photograph
  cannot be exact; the SSIM in the message is how close it got. If you need the
  pixels, use the lossless command and take the embedded result.
- Nothing is uploaded. The engine runs locally in the extension host.

## Marketplace icon

 is generated from , composited on the brand paper colour
with padding so it does not sit edge-to-edge inside a rounded tile.

## Licence

MIT, same as Vecline. Source lives in
[`extensions/vscode`](https://github.com/shunyagatha/Vecline/tree/main/extensions/vscode).
