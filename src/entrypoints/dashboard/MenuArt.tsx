import { useReducedMotion } from '@mantine/hooks';
import { type PointerEvent, useEffect, useRef } from 'react';
import { buildSkyline, createFireScene, type FireScene } from './menu-art-scene';

const CITY_FAR = buildSkyline(7, 668, 18, 80, 7, 18);
const CITY_NEAR = buildSkyline(23, 702, 26, 120, 10, 26);
/** The head is drawn upright, then tilted and enlarged around its centre. */
const HEAD = 'translate(290 262) rotate(12) scale(1.18) translate(-290 -262)';

/**
 * The fire mage art at the bottom of the menu, painted live: two still SVG layers (the dusk sky
 * and city, then the figure on its cliff) with the moving fire drawn on canvases around them (see
 * menu-art-scene.ts). A light follows the pointer over it, and a click stokes the fireball. It
 * sits under the menu's links, which take their own hover and clicks first (see dashboard.css):
 * over a link the light fades out. With reduced motion it is a still image.
 */
export function MenuArt() {
  const reduceMotion = useReducedMotion(false, { getInitialValueInEffect: false });
  const stageRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<SVGSVGElement>(null);
  const backRef = useRef<HTMLCanvasElement>(null);
  const frontRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<FireScene | null>(null);

  useEffect(() => {
    const stage = stageRef.current!;
    const scene = createFireScene(backRef.current!, frontRef.current!);
    sceneRef.current = scene;
    const resize = () => scene.resize(stage.clientWidth, stage.clientHeight, window.devicePixelRatio);
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(stage);
    if (reduceMotion) {
      return () => {
        resizeObserver.disconnect();
        sceneRef.current = null;
      };
    }

    // Animate only while the art is on screen (the menu slides out of view on small screens).
    let frameId = 0;
    let lastTime = 0;
    const frame = (now: number) => {
      scene.update(Math.min(3, (now - lastTime) / 16.667));
      lastTime = now;
      scene.render();
      frameId = requestAnimationFrame(frame);
    };
    const visibility = new IntersectionObserver(([entry]) => {
      cancelAnimationFrame(frameId);
      if (!entry.isIntersecting) return;
      lastTime = performance.now();
      frameId = requestAnimationFrame(frame);
    });
    visibility.observe(stage);
    return () => {
      cancelAnimationFrame(frameId);
      visibility.disconnect();
      resizeObserver.disconnect();
      sceneRef.current = null;
    };
  }, [reduceMotion]);

  const point = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    sceneRef.current?.point(((event.clientX - box.left) / box.width) * 600, ((event.clientY - box.top) / box.height) * 800);
  };

  const stoke = () => {
    sceneRef.current?.stoke();
    backdropRef.current?.animate([{ filter: 'brightness(1.55) saturate(1.2)' }, { filter: 'none' }], { duration: 900, easing: 'ease-out' });
  };

  return (
    <div
      ref={stageRef}
      className="ti-menu-art"
      data-interactive={!reduceMotion || undefined}
      onClick={reduceMotion ? undefined : stoke}
      onPointerMove={reduceMotion ? undefined : point}
      onPointerLeave={reduceMotion ? undefined : () => sceneRef.current?.unpoint()}
      aria-hidden
    >
      <svg ref={backdropRef} className="ti-menu-art-layer" viewBox="0 0 600 800">
        <defs>
          <linearGradient id="ti-art-sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#14050c" />
            <stop offset="0.38" stopColor="#3b0a19" />
            <stop offset="0.64" stopColor="#8a2016" />
            <stop offset="0.78" stopColor="#d9581d" />
            <stop offset="0.845" stopColor="#ffa548" />
            <stop offset="0.9" stopColor="#ff7a2a" />
            <stop offset="1" stopColor="#7a1d12" />
          </linearGradient>
          <radialGradient id="ti-art-ball-light" cx="232" cy="104" r="380" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#ffb347" stopOpacity="0.6" />
            <stop offset="0.35" stopColor="#ff5a14" stopOpacity="0.22" />
            <stop offset="1" stopColor="#ff5a14" stopOpacity="0" />
          </radialGradient>
          <filter id="ti-art-haze" x="-20%" y="-100%" width="140%" height="300%">
            <feGaussianBlur stdDeviation="12" />
          </filter>
        </defs>
        <rect width="600" height="800" fill="url(#ti-art-sky)" />
        <g filter="url(#ti-art-haze)" opacity="0.75">
          <ellipse cx="120" cy="410" rx="230" ry="20" fill="#2a0711" />
          <ellipse cx="480" cy="350" rx="210" ry="16" fill="#2a0711" />
          <ellipse cx="390" cy="515" rx="260" ry="24" fill="#5c1414" />
          <ellipse cx="70" cy="565" rx="190" ry="18" fill="#6d1a12" />
          <ellipse cx="300" cy="200" rx="320" ry="26" fill="#1c060d" />
        </g>
        <rect width="600" height="800" fill="url(#ti-art-ball-light)" />
        {/* Two airships. */}
        <g fill="#2a0a12" opacity="0.8">
          <ellipse cx="478" cy="292" rx="19" ry="5" />
          <path d="M494,292 L503,285 L501,292 L503,299 Z" />
          <path d="M472,296 h10 v4 h-10 Z" />
          <ellipse cx="540" cy="248" rx="10" ry="2.8" />
          <path d="M549,248 L554,244 L553,248 L554,252 Z" />
        </g>
        <path d={CITY_FAR} fill="#7a2418" opacity="0.6" />
        <path d={CITY_NEAR} fill="#2a0b0e" />
      </svg>

      <canvas ref={backRef} className="ti-menu-art-layer" />

      <svg className="ti-menu-art-layer" viewBox="0 0 600 800">
        <defs>
          <filter id="ti-art-rim-wide" x="-10%" y="-10%" width="120%" height="120%">
            <feMorphology operator="dilate" radius="2.4" />
          </filter>
          <filter id="ti-art-rim-thin" x="-10%" y="-10%" width="120%" height="120%">
            <feMorphology operator="dilate" radius="1.3" />
          </filter>
          <filter id="ti-art-soft-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="14" />
          </filter>
          <filter id="ti-art-eye-glow" x="-300%" y="-300%" width="700%" height="700%">
            <feGaussianBlur stdDeviation="2.5" />
          </filter>
          <linearGradient id="ti-art-hair-fire" x1="300" y1="292" x2="350" y2="150" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#fff3c4" />
            <stop offset="0.28" stopColor="#ffc04a" />
            <stop offset="0.58" stopColor="#ff6a1a" stopOpacity="0.95" />
            <stop offset="0.84" stopColor="#d2261b" stopOpacity="0.6" />
            <stop offset="1" stopColor="#8a1218" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="ti-art-rock-fill" x1="0" y1="680" x2="0" y2="800" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#2c0e11" />
            <stop offset="1" stopColor="#0b0405" />
          </linearGradient>
          <path
            id="ti-art-rock"
            d="M0,800 L0,738 L38,731 L72,736 L110,726 L150,729 L182,718 L214,716 L256,716 L288,720 L318,708 L340,694 L362,684 L392,683 L424,686 L452,694 L486,700 L520,712 L556,708 L600,714 L600,800 Z"
          />
          <path
            id="ti-art-hair"
            d="M284,234 C288,218 300,208 312,204 C318,190 318,174 312,156 C330,170 336,188 332,204 C346,186 364,178 386,176 C372,188 364,200 362,214 C378,208 394,210 406,218 C386,222 370,232 358,246 C354,264 342,278 322,288 C324,270 320,252 308,242 C300,236 292,234 284,234 Z"
          />
          {/* The figure's silhouette, in currentColor: drawn as a glow, two rims, then solid. */}
          <g id="ti-art-figure">
            <path fill="currentColor" d="M326,418 C356,440 396,458 448,500 C428,506 412,506 398,512 C424,530 446,548 468,580 C430,578 392,566 356,540 C342,522 336,500 332,474 Z" />
            <path fill="currentColor" d="M262,466 L304,470 C298,520 282,560 268,592 L238,586 C244,548 252,508 262,466 Z" />
            <circle fill="currentColor" cx="253" cy="588" r="15" />
            <path fill="currentColor" d="M238,584 L268,590 C260,628 252,664 248,690 L224,690 C226,660 232,620 238,584 Z" />
            <path fill="currentColor" d="M222,682 L250,682 L252,716 L204,716 C205,708 212,703 222,699 Z" />
            <path fill="currentColor" d="M298,466 L340,464 C358,500 372,538 384,570 L352,584 C340,548 320,508 298,466 Z" />
            <circle fill="currentColor" cx="368" cy="577" r="16" />
            <path fill="currentColor" d="M352,578 L384,570 C386,606 388,640 390,668 L366,670 C364,640 358,610 352,578 Z" />
            <path fill="currentColor" d="M364,660 L392,660 C394,668 400,674 410,678 C415,680 416,684 416,686 L362,686 Z" />
            <path fill="currentColor" d="M256,322 C272,312 304,310 334,320 C342,342 340,372 330,402 C326,422 330,446 338,472 L262,476 C268,452 272,430 270,408 C262,396 252,380 252,362 C252,346 252,334 256,322 Z" />
            <path fill="currentColor" d="M274,286 L294,298 L308,322 L270,322 Z" />
            <circle fill="currentColor" cx="262" cy="326" r="14" />
            <path fill="currentColor" d="M252,331 L272,318 L232,259 L216,269 Z" />
            <circle fill="currentColor" cx="224" cy="264" r="9.5" />
            <path fill="currentColor" d="M215.6,262.8 L232.4,265.2 L239.9,192.8 L228.1,191.2 Z" />
            <ellipse fill="currentColor" cx="235" cy="181" rx="8.5" ry="10.5" />
            <circle fill="currentColor" cx="330" cy="328" r="14" />
            <path fill="currentColor" d="M339,320 L321,336 L369,386 L383,374 Z" />
            <circle fill="currentColor" cx="376" cy="380" r="9.5" />
            <path fill="currentColor" d="M379.8,372.4 L372.2,387.6 L421.3,409.4 L426.7,398.6 Z" />
            <ellipse fill="currentColor" cx="433" cy="407" rx="10" ry="8" transform="rotate(25 433 407)" />
            <g fill="none" stroke="currentColor" strokeWidth="4.2" strokeLinecap="round">
              <path d="M229,174 L223,159 M234,171 L233,154 M239,172 L243,156 M243,177 L251,165 M227,184 L218,175" />
              <path d="M438,401 L453,394 M441,406 L458,405 M439,412 L454,418 M434,414 L445,426 M429,400 L436,388" />
            </g>
            <g transform={HEAD}>
              <path
                fill="currentColor"
                d="M292,231 C307,230 319,241 319,257 C319,271 313,283 306,291 L298,297 C292,294 285,292 278,289 C272,287 267,284 265,280 C263,276 264,272 265,270 L263,267 L266,264 L258,259 C261,255 264,252 266,248 C268,239 278,232 292,231 Z"
              />
              <ellipse fill="currentColor" cx="278" cy="237" rx="9" ry="6" transform="rotate(-28 278 237)" />
            </g>
          </g>
        </defs>

        <use href="#ti-art-rock" fill="#ff8a3a" opacity="0.8" transform="translate(-1.5 -3)" />
        <use href="#ti-art-rock" fill="url(#ti-art-rock-fill)" />
        <g fill="none" stroke="#ff7a2a" strokeWidth="1.4" strokeLinecap="round" opacity="0.22">
          <path d="M340,694 L330,740 L344,800" />
          <path d="M182,718 L170,760 L176,800" />
          <path d="M452,694 L470,750" />
          <path d="M72,736 L84,780" />
        </g>

        <use href="#ti-art-figure" color="#ff5a14" opacity="0.55" filter="url(#ti-art-soft-glow)" />
        <use href="#ti-art-figure" color="#c8321a" filter="url(#ti-art-rim-thin)" transform="translate(1.6 0.6)" />
        <use href="#ti-art-figure" color="#ffd27a" filter="url(#ti-art-rim-wide)" transform="translate(-2.2 -2.4)" />
        <use href="#ti-art-figure" color="#160709" />

        {/* Belt, knee and coat lines, the raised arm's bracers, the hairline. */}
        <g fill="none" stroke="#ff9d52" strokeWidth="1.6" strokeLinecap="round" opacity="0.5">
          <path d="M272,432 C292,438 312,438 328,432" />
          <path d="M296,429 h9 v11 h-9 Z" />
          <path d="M232,640 C240,644 250,644 257,640" />
          <path d="M360,628 C368,632 378,632 387,628" />
          <path d="M334,476 C348,502 362,522 384,542" />
          <path d="M224,214 L238,216 M222,232 L236,234" stroke="#ffc66b" strokeWidth="2.2" />
          <g transform={HEAD}>
            <path d="M286,236 C298,236 310,242 318,252" />
          </g>
        </g>

        {/* Brow, glowing eye and burning hair. */}
        <g transform={HEAD}>
          <path d="M270.5,234 A9 6 -28 0 1 283,229.5" fill="none" stroke="#ffe3a0" strokeWidth="1.6" strokeLinecap="round" />
          <ellipse cx="273" cy="252" rx="4.5" ry="2.4" fill="#ff8a2a" filter="url(#ti-art-eye-glow)" />
          <ellipse cx="273" cy="252" rx="2.6" ry="1.2" fill="#fff0c0" />
          <use href="#ti-art-hair" fill="url(#ti-art-hair-fire)" filter="url(#ti-art-soft-glow)" opacity="0.8" />
          <use href="#ti-art-hair" fill="url(#ti-art-hair-fire)" />
        </g>
      </svg>

      <canvas ref={frontRef} className="ti-menu-art-layer" />
      <div className="ti-menu-art-layer ti-menu-art-vignette" />
      <div className="ti-menu-art-layer ti-menu-art-shade" />
    </div>
  );
}
