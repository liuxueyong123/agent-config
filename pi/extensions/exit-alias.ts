/**
 * /exit 别名扩展
 *
 * Pi 内置的退出命令是 /quit。本扩展额外注册 /exit，
 * 以适配习惯使用 /exit 的场景，行为与 /quit 一致：干净关闭进程。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("exit", {
		description: "Exit Pi cleanly (alias of /quit)",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});
}
