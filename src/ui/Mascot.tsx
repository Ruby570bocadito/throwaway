/** The paper-ball mascot's poses (Muse, 22-nov), drawn in the illustrations' style: public/mascot/<pose>-256.webp. */
export type Pose = 'wave' | 'scan' | 'alarm' | 'blur' | 'safe' | 'think';

const SIZE: Record<Pose, [number, number]> = {
  wave: [256, 246],
  scan: [256, 256],
  alarm: [237, 256],
  blur: [187, 256],
  safe: [238, 256],
  think: [206, 256],
};

/**
 * The mascot next to each step's title, reacting to it: waving at the start, the magnifying glass while Gemini Nano looks,
 * thinking while the cloud AI tries, alarmed when it found you, the frosted glass for a fix, arms up when it lost you.
 * It hops in whenever its pose changes (the key remounts it). Decoration: the title and the sentence say it all.
 */
export function Mascot({ pose, className = '' }: { pose: Pose; className?: string }) {
  const [width, height] = SIZE[pose];
  return (
    <img
      key={pose}
      className={`mascot ${className}`}
      src={`/mascot/${pose}-256.webp`}
      width={width}
      height={height}
      alt=""
      aria-hidden="true"
      decoding="async"
      data-pose={pose}
    />
  );
}

/** Fetch every pose once the page is idle, so a change of pose never waits for the network. */
export function preloadMascot() {
  for (const pose of Object.keys(SIZE)) new Image().src = `/mascot/${pose}-256.webp`;
}
