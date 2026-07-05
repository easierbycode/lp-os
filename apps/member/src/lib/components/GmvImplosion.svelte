<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  // Phaser is heavy (>1 MB) and browser-only — never imported at the top
  // level. We lazy-import inside `onMount`, which Svelte only invokes on
  // the client. The dynamic `any` is intentional; pulling in Phaser's
  // type bundle just to type a one-off scene isn't worth the build cost.
  // deno-lint-ignore-file no-explicit-any

  let {
    gmv = "0",
    label = "GMV ($)",
  }: { gmv?: string; label?: string } = $props();

  let host: HTMLDivElement | undefined = $state();
  let game: any = null;

  // Stage size. Picked so a 5-character GMV (e.g. "$1428K") still fits at
  // a punchy 120px font and the implosion has runway to scatter from.
  const W = 640;
  const H = 200;

  // Texture key under which we register the rasterized GMV. The
  // assemblePixels routine reads it from `this.textures.getFrame()`.
  const TEXTURE = "gmv_asset";

  /**
   * Render the GMV string to a freestanding 2D canvas and return it. The
   * canvas is what gets registered as a Phaser texture; `assemblePixels`
   * later reads its pixel data via `frame.source.image`.
   *
   * The text is filled with a vertical gradient so each sampled pixel
   * carries its own color — that's what gives the imploded form a real
   * "made of pixels" look instead of a uniform-colored swarm.
   */
  function rasterizeGmv(text: string): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d")!;
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "#fde68a");
    grad.addColorStop(0.5, "#fbbf24");
    grad.addColorStop(1, "#f54e00");
    ctx.fillStyle = grad;
    ctx.font =
      '900 120px "SF Pro Display", "Helvetica Neue", system-ui, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, W / 2, H / 2);
    return canvas;
  }

  onMount(async () => {
    if (!host) return;
    // Phaser 4 ships ESM with *named exports only* — there is no default
    // export. `import("phaser").default` is undefined and `Phaser.Scene`
    // would explode. The module namespace object behaves as `Phaser` for
    // our purposes (every top-level Phaser symbol is on it directly).
    const Phaser = await import("phaser");

    const display = `$${gmv}`;
    const sourceCanvas = rasterizeGmv(display);

    // Single-scene game. The class lives inside `onMount` because
    // `Phaser.Scene` is only loaded after the dynamic import — it can't be
    // hoisted to module scope.
    // svelte-ignore perf_avoid_nested_class
    class GmvScene extends Phaser.Scene {
      private particleContainer: any = null;
      private pixelImages: Array<{ img: any; fx: number; fy: number }> | null =
        null;

      constructor() {
        super("gmv");
      }

      preload() {
        // Register our pre-rasterized GMV canvas as a Phaser texture so
        // `assemblePixels` can read it back as a Frame.
        this.textures.addCanvas(TEXTURE, sourceCanvas);
      }

      create() {
        this.cameras.main.setBackgroundColor("#1a1916");

        this.assemblePixels("__BASE", () => {
          // After the swarm finishes assembling, fade in a crisp Text on
          // top so the user has a sharp, copy-pasteable number — and dim
          // the pixel cloud a hair so it reads as backdrop, not the
          // headline.
          const text = this.add
            .text(W / 2, H / 2, display, {
              fontFamily:
                "SF Pro Display, Helvetica Neue, system-ui, sans-serif",
              fontStyle: "900",
              fontSize: "120px",
              color: "#f54e00",
            })
            .setOrigin(0.5)
            .setAlpha(0)
            .setDepth(10);
          this.tweens.add({ targets: text, alpha: 1, duration: 700 });
          if (this.pixelImages) {
            this.tweens.add({
              targets: this.pixelImages.map((p) => p.img),
              alpha: 0.35,
              duration: 700,
            });
          }
        });
      }

      /**
       * Tear down a previously assembled pixel swarm so back-to-back
       * implosions don't leak rectangles into the scene.
       */
      clearPixels() {
        if (this.particleContainer) {
          this.particleContainer.destroy();
          this.particleContainer = null;
        }
        this.pixelImages = null;
      }

      /**
       * Sample the named texture frame and animate one rectangle per
       * non-transparent pixel from a random off-stage start position to
       * its target offset (centered in `this.particleContainer`).
       *
       * Calls `onDone` once every tween reports complete or after a
       * 2 s wall-clock fallback — Phaser's tween clock can be paused or
       * throttled by tab visibility, so the setTimeout guarantees the
       * follow-up animation step always runs.
       *
       * Adapted from the standard "assemble pixels from frame" pattern:
       *   - SAMPLE  = 3   downsample step (every Nth pixel sampled)
       *   - MAX     = 1500 cap on total particles to keep WebGL happy
       *   - scale   = 1   our source canvas is already at display size
       *   - ease    = Cubic.easeOut — particles arrive softly, no overshoot
       */
      assemblePixels(frameKey: string, onDone?: () => void) {
        const sceneW = this.scale.width;
        const sceneH = this.scale.height;

        const frame = this.textures.getFrame(TEXTURE, frameKey);
        if (!frame) {
          onDone?.();
          return;
        }

        // Read the frame's underlying canvas back into image data. For a
        // CanvasTexture this is the same canvas we passed to
        // `addCanvas` — but we still copy through `drawImage` so this
        // works identically against atlas/spritesheet sources later.
        const canvas = document.createElement("canvas");
        canvas.width = frame.width;
        canvas.height = frame.height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(
          (frame.source.image as CanvasImageSource),
          frame.cutX,
          frame.cutY,
          frame.width,
          frame.height,
          0,
          0,
          frame.width,
          frame.height,
        );
        const imageData = ctx.getImageData(0, 0, frame.width, frame.height);

        this.clearPixels();
        this.particleContainer = this.add
          .container(sceneW / 2, sceneH / 2)
          .setDepth(5);

        const SAMPLE = 3;
        const MAX = 1500;
        const scale = 1;
        let count = 0;
        let done = 0;
        let resolved = false;
        const particles: Array<{ img: any; fx: number; fy: number }> = [];

        for (let y = 0; y < frame.height; y += SAMPLE) {
          for (let x = 0; x < frame.width; x += SAMPLE) {
            if (count >= MAX) break;
            const i = (y * frame.width + x) * 4;
            const a = imageData.data[i + 3];
            if (a > 127) {
              const fx = (x - frame.width / 2) * scale;
              const fy = (y - frame.height / 2) * scale;
              const startX = Phaser.Math.Between(-sceneW / 2, sceneW / 2);
              const startY = Phaser.Math.Between(-sceneH / 2, sceneH / 2);
              const color = Phaser.Display.Color.GetColor(
                imageData.data[i],
                imageData.data[i + 1],
                imageData.data[i + 2],
              );
              const img = this.add
                .rectangle(startX, startY, SAMPLE, SAMPLE, color)
                .setAlpha(0);
              this.particleContainer.add(img);
              particles.push({ img, fx, fy });
              count++;
            }
          }
          if (count >= MAX) break;
        }

        if (count === 0) {
          onDone?.();
          return;
        }

        this.pixelImages = particles;

        const finish = () => {
          if (resolved) return;
          resolved = true;
          onDone?.();
        };

        for (let p = 0; p < particles.length; p++) {
          const part = particles[p];
          this.tweens.add({
            targets: part.img,
            x: part.fx,
            y: part.fy,
            alpha: 1,
            duration: 600 + Math.random() * 300,
            delay: Math.random() * 300,
            ease: "Cubic.easeOut",
            onComplete: () => {
              done++;
              if (done >= count) finish();
            },
          });
        }

        // Wall-clock fallback — Phaser's tween clock pauses when the tab
        // is backgrounded, so an `onComplete`-only signal can stall.
        // setTimeout fires regardless and `finish()` is idempotent.
        setTimeout(finish, 2000);
      }
    }

    game = new Phaser.Game({
      type: Phaser.AUTO,
      width: W,
      height: H,
      parent: host,
      transparent: false,
      backgroundColor: "#1a1916",
      scene: [GmvScene],
      scale: { mode: Phaser.Scale.NONE },
      render: { pixelArt: false, antialias: true },
    });
  });

  onDestroy(() => {
    game?.destroy(true);
    game = null;
  });
</script>

<div class="gmv-implosion">
  <div class="gmv-implosion__label">{label}</div>
  <div bind:this={host} class="gmv-implosion__stage"></div>
  <div class="gmv-implosion__hint">
    Phaser 4 — pixel implosion. {gmv} · live session GMV
  </div>
</div>

<style>
  .gmv-implosion {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 1.25rem 1.5rem;
    background: var(--card, #232220);
    border: 1px solid var(--border, rgba(242, 241, 237, 0.1));
    border-radius: var(--radius, 14px);
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.35),
      0 0 0 1px rgb(245 78 0 / 0.18);
    color: var(--foreground, #f2f1ed);
  }
  .gmv-implosion__label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted-foreground, rgba(242, 241, 237, 0.6));
  }
  .gmv-implosion__stage {
    width: 100%;
    max-width: 640px;
    aspect-ratio: 640 / 200;
    border-radius: 10px;
    overflow: hidden;
    background: #1a1916;
  }
  /* Phaser plants its <canvas> as a child — make it scale fluidly. */
  .gmv-implosion__stage :global(canvas) {
    width: 100% !important;
    height: 100% !important;
    display: block;
  }
  .gmv-implosion__hint {
    font-size: 11px;
    color: var(--muted-foreground, rgba(242, 241, 237, 0.5));
  }
</style>
