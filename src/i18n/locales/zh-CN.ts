import { commonMessages } from "../messages/common";
import { libraryMessages } from "../messages/library";
import { libraryDetailMessages } from "../messages/libraryDetail";
import { settingsMessages } from "../messages/settings";
import { browserMessages } from "../messages/browser";
import { readerMessages } from "../messages/reader";
import { updatesMessages } from "../messages/updates";
import { privacyMessages } from "../messages/privacy";
import { resilienceMessages } from "../messages/resilience";
import { onlineMessages } from "../messages/online";

export const zhCN = {
  ...commonMessages["zh-CN"],
  ...libraryMessages["zh-CN"],
  ...libraryDetailMessages["zh-CN"],
  ...settingsMessages["zh-CN"],
  ...browserMessages["zh-CN"],
  ...readerMessages["zh-CN"],
  ...updatesMessages["zh-CN"],
  ...privacyMessages["zh-CN"],
  ...onlineMessages["zh-CN"],
  ...resilienceMessages["zh-CN"],
} as const;

export type MessageKey = keyof typeof zhCN;
export type Messages = Record<MessageKey, string>;
