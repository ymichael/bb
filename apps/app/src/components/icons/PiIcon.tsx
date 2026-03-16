export function PiIcon({ className }: { className?: string }) {
  return (
    <svg
      fill="currentColor"
      fillRule="evenodd"
      viewBox="100 100 600 600"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <title>Pi</title>
      {/* P shape: outer boundary clockwise, inner hole counter-clockwise */}
      <path d="
        M165.29 165.29
        H517.36
        V400
        H400
        V517.36
        H282.65
        V634.72
        H165.29
        Z
        M282.65 282.65
        V400
        H400
        V282.65
        Z
      " />
      {/* i dot */}
      <path d="M517.36 400 H634.72 V634.72 H517.36 Z" />
    </svg>
  )
}
