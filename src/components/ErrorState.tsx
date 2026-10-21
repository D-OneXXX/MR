import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import PixelPet from "./PixelPet";

/** 统一错误态：像素宠物 + 原因 + 重试。 */
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
        <Button variant="pill" size="pill-sm" onClick={onRetry}>
          <RotateCcw />
          重试
        </Button>
      )}
    </div>
  );
}
