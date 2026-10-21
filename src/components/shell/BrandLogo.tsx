/**
 * 导航栏品牌标识（方案 B）：晴空蓝硬阴影徽章 + 极简开卷。
 * 纯内联 SVG，不依赖外部图片或第三方品牌素材。
 */
export default function BrandLogo() {
  return (
    <div className="flex select-none items-center gap-2.5">
      <svg
        aria-hidden="true"
        focusable="false"
        className="size-8 shrink-0 transition-transform duration-150 hover:scale-105"
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect x="6" y="10" width="52" height="50" rx="16" fill="#09090B" />
        <rect
          x="6"
          y="6"
          width="52"
          height="50"
          rx="16"
          fill="#38A8F8"
          stroke="#09090B"
          strokeWidth="3"
        />
        <path
          d="M17 19C17 17.3431 18.3431 16 20 16H30C31.1046 16 32 16.8954 32 18V42C32 40.8954 31.1046 40 30 40H21L17 44V19Z"
          fill="#FFFFFF"
          stroke="#09090B"
          strokeWidth="3"
          strokeLinejoin="round"
        />
        <path
          d="M47 19C47 17.3431 45.6569 16 44 16H34C32.8954 16 32 16.8954 32 18V42C32 40.8954 32.8954 40 34 40H44C45.6569 40 47 38.6569 47 37V19Z"
          fill="#FFFFFF"
          stroke="#09090B"
          strokeWidth="3"
          strokeLinejoin="round"
        />
      </svg>
      <span className="text-lg font-extrabold tracking-tight text-foreground">
        Manga<span className="text-[#38A8F8]">Reader</span>
      </span>
    </div>
  );
}
