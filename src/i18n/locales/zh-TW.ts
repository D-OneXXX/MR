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
import type { Messages } from "./zh-CN";

export const zhTW = {
  ...commonMessages["zh-TW"],
  ...libraryMessages["zh-TW"],
  ...libraryDetailMessages["zh-TW"],
  ...settingsMessages["zh-TW"],
  ...browserMessages["zh-TW"],
  ...readerMessages["zh-TW"],
  ...updatesMessages["zh-TW"],
  ...privacyMessages["zh-TW"],
  ...onlineMessages["zh-TW"],
  ...resilienceMessages["zh-TW"],
} satisfies Messages;
