import { RotateCcw } from "lucide-react";
import PixelPet from "./PixelPet";

/** 统一错误态（P1 三态红线）：像素宠物 + 原因 + 重试。 */
export default function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="pet-wrap">
      <PixelPet mode="empty" message={message} />
      {onRetry && (
        <button className="btn" onClick={onRetry}>
          <RotateCcw size={14} /> 重试
        </button>
      )}
    </div>
  );
}
