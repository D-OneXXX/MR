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

export const ko = {
  ...commonMessages.ko,
  ...libraryMessages.ko,
  ...libraryDetailMessages.ko,
  ...settingsMessages.ko,
  ...browserMessages.ko,
  ...readerMessages.ko,
  ...updatesMessages.ko,
  ...privacyMessages.ko,
  ...onlineMessages["ko"],
  ...resilienceMessages.ko,
} satisfies Messages;
