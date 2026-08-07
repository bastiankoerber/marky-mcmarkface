export function BrandIcon({
  className = '',
  size = 64,
}: {
  className?: string;
  size?: number;
}) {
  return (
    <img
      className={className}
      src="/icons/logo-64.png"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
