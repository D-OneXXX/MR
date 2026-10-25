import { useI18n } from "@/i18n";

interface Props {
  mode?: "empty" | "loading";
  message?: string;
}

/** 像素宠物彩蛋：纯 CSS，放在加载中与空状态 */
export default function PixelPet({ mode = "empty", message }: Props) {
  const { t } = useI18n();
  const text =
    message ??
    (mode === "loading" ? t("pet.loading") : t("pet.empty"));
  return (
    <div className="pet-wrap">
      <div className="pixel-pet" aria-hidden />
      <div className={`pet-bubble${mode === "loading" ? " pet-loading-dots" : ""}`}>
        {text}
      </div>
    </div>
  );
}
