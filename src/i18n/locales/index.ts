import { zhCN, type MessageKey, type Messages } from "./zh-CN";
import { zhTW } from "./zh-TW";
import { en } from "./en";
import { es } from "./es";
import { ja } from "./ja";
import { ko } from "./ko";

export const messages = {
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  en,
  es,
  ja,
  ko,
} satisfies Record<string, Messages>;

export type { MessageKey, Messages };
