import { describe, expect, it } from "vitest";

import { formatLocalizedUiError, localeForLanguageSetting, localizeUiMessage, t } from "./i18n.js";

describe("renderer i18n", () => {
  it("localizes generated task and action error messages in Simplified Chinese", () => {
    expect(localizeUiMessage("zh-CN", "Queued task:scan:1")).toBe("已加入队列：task:scan:1");
    expect(localizeUiMessage("zh-CN", "Queued migration task:deployment:1")).toBe(
      "迁移已加入队列：task:deployment:1",
    );
    expect(localizeUiMessage("zh-CN", "Deployment complete: 1 succeeded.")).toBe(
      "部署已完成：1 项成功。",
    );
    expect(localizeUiMessage("zh-CN", "deployment writing: 2/5 operations")).toBe(
      "部署正在写入：2/5 项操作",
    );
    expect(localizeUiMessage("zh-CN", "Target already exists: /project/rule.mdc")).toBe(
      "目标已存在：/project/rule.mdc",
    );
    expect(localizeUiMessage("zh-CN", "Source changed before deployment: asset:rule")).toBe(
      "部署前源资产已变更：asset:rule",
    );
    expect(
      formatLocalizedUiError(
        "zh-CN",
        new Error("No such interface org.freedesktop.portal.FileChooser"),
        "Select project",
      ),
    ).toContain("选择项目失败：系统文件选择器不可用");
  });

  it("covers asset review and migration labels that appear in Chinese mode", () => {
    expect(t("zh-CN", "No assets match the selected tool.")).toBe("没有匹配所选工具的资产。");
    expect(t("zh-CN", "Source directory")).toBe("来源目录");
    expect(t("zh-CN", "Will load")).toBe("是否加载");
    expect(t("zh-CN", "No, covered by {asset}", { asset: "mcp:docs" })).toBe(
      "否，已被 mcp:docs 覆盖",
    );
    expect(t("zh-CN", "Agent")).toBe("Agent");
    expect(t("zh-CN", "Rule")).toBe("Rule");
    expect(t("zh-CN", "Skill")).toBe("Skill");
  });

  it("localizes asset status failure messages from the desktop service", () => {
    expect(
      localizeUiMessage(
        "zh-CN",
        "Cannot restore disabled asset because a file already exists at the original path",
      ),
    ).toBe(
      "\u65e0\u6cd5\u6062\u590d\u8be5\u8d44\u4ea7\uff1a\u539f\u8def\u5f84\u5df2\u6709\u6587\u4ef6\u3002",
    );
  });

  it("follows Simplified Chinese system preferences when language is system", () => {
    expect(localeForLanguageSetting("system", ["zh-CN", "en-US"])).toBe("zh-CN");
  });

  it("keeps explicit English even when the system preference is Simplified Chinese", () => {
    expect(localeForLanguageSetting("en", ["zh-CN"])).toBe("en");
  });
});
