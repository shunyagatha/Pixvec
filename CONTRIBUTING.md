# Contributing to vexel

Thanks for considering it. This document covers the things that are specific to this project; the usual open-source etiquette applies otherwise.

## Getting set up

```bash
git clone https://github.com/shunyagatha/vexel.git
cd vexel
npm install
npm run build
npm test
```

Node.js 18.17 or newer. The two native dependencies (`sharp`, `@resvg/resvg-js`) ship prebuilt binaries for Linux, macOS and Windows, so no compiler toolchain is needed.

## The one rule that matters

**Accuracy claims must be measured, never asserted.**

This project's entire value proposition is that when it says "bit-exact", it rendered the output and compared it pixel by pixel. A change that improves a number without a test proving it, or that reports a construction-time claim over a contradicting measurement, will not be merged no matter how good it looks.

Concretely:

- If you add a conversion path, add a test that round-trips it and asserts on the measured report.
- If a mode is exact by construction, prove it in a test — `expect(report.lossless).toBe(true)`, not a comment.
- If something is *approximate*, say so in the output and in the docs. Understating a limitation is worse than having it.

## Tests

```bash
npm test              # once
npm run test:watch    # while working
```

Fixtures are **generated from code** in `test/fixtures.ts`, not committed as binary files. Please keep it that way. Binary test assets rot: nobody can review a diff of them, and a resampling change in an image library silently invalidates every expectation built on them. If you need a new fixture, add a generator function with a comment saying which property it probes.

Every bug fixed should arrive with a regression test that fails without the fix. The existing ones are marked with a `Regression:` comment explaining the original failure — please follow that pattern, because a test whose purpose is not obvious gets deleted by someone during a future refactor.

## Code style

There is no linter config to fight with. Match the surrounding code:

- Comments explain **why**, not what. If a line needs a comment saying what it does, rename something instead.
- Constants that encode a judgement call (a threshold, a budget, a tolerance) get a named constant and a comment justifying the value.
- Prefer typed arrays in hot loops. Image code runs over millions of pixels; a `Map` in the wrong place costs seconds.
- Public API surface is documented with TSDoc. Internal helpers get a comment only where the reasoning is non-obvious.

## Performance

Image processing has a wide dynamic range of input sizes. Before optimising, measure with a realistic input — a 12-megapixel photo, not a 64×64 fixture. Before adding an allocation inside a per-pixel loop, don't.

If a change trades memory for speed, say so in the comment and give the number. `NearestColor` allocating a 33 MB table above a threshold is fine *because it says so*; the same code without the comment would be a landmine.

## Areas that would genuinely help

- **More input formats.** JPEG XL and HEIC would be welcome if they can be done without a heavyweight dependency.
- **Better tracing quality.** The current pipeline is Douglas–Peucker plus Schneider fitting. potrace's optimal-polygon stage would likely beat it on smooth curves; a comparison with measured numbers would be a great contribution even if the answer is "no".
- **Gradient detection.** Large smooth regions currently become many flat bands. Emitting a `<linearGradient>` where one genuinely fits would cut both file size and error.
- **Speed.** Contour tracing and quantisation are single-threaded. Worker threads would help on large inputs.
- **Real-world benchmark corpus.** A licence-clean set of images with published numbers would make quality regressions visible.

## Reporting bugs

Please include the input image if you can share it, the exact command, and the `--json` output. A quality complaint without an input image is almost impossible to act on.

If the bug is "the output looks wrong", `--verify` output is the fastest way to tell a rendering problem from a geometry problem.

## Releasing

Maintainers only:

```bash
npm run build && npm test
npm version <patch|minor|major>
git push --follow-tags
npm publish
```

`VERSION` in `src/api.ts` is the source of truth for the generator comment and must match `package.json`.
