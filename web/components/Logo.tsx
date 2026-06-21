import { cn } from "@/lib/utils";

/**
 * Logo — the shared HostIt brand mark, wrapping the real `logo-white.png`
 * asset. Used by the Header and Footer (and anywhere a brand mark is needed)
 * so the inline `<img>` isn't duplicated. The light-surface variant
 * (`logo-navy.png`) ships too but isn't used while the app is dark-locked.
 *
 * `size` sets the rendered height in px (width stays auto); `className`
 * forwards extra classes (e.g. opacity) to the `<img>`.
 */
export function Logo({
  size = 24,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/brand/logo-white.png"
      alt="HostIt"
      height={size}
      style={{ height: size }}
      className={cn("block w-auto", className)}
    />
  );
}
