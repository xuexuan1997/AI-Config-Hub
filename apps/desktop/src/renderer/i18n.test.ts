import { describe, expect, it } from "vitest";

import { formatLocalizedUiError, localizeUiMessage, t } from "./i18n.js";

describe("renderer i18n", () => {
  it("localizes generated task and action error messages in Simplified Chinese", () => {
    expect(localizeUiMessage("zh-CN", "Queued task:scan:1")).toBe("已加入队列 task:scan:1");
    expect(localizeUiMessage("zh-CN", "Deployment complete: 1 succeeded.")).toBe(
      "部署已完成：1 项成功。",
    );
    expect(localizeUiMessage("zh-CN", "deployment writing: 2/5 operations")).toBe(
      "部署正在写入：2/5 项操作",
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
    expect(t("zh-CN", "Agent")).toBe("代理");
    expect(t("zh-CN", "Rule")).toBe("规则");
  });
});
