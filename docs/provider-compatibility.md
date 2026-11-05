# 平台与模型配置（beta.51）

本版提供 DeepSeek 官方、火山方舟、阿里云百炼、OpenAI 官方和自定义兼容服务。平台模板不代表该平台的所有模型都支持聊天、思考和工具；模型列表也不是能力清单。

## 新增与切换

1. 在 Zotero 设置 → ZaiChat 点击“新增模型配置”，选择平台。
2. 核对 API 地址，填写该地址对应的密钥和准确模型 ID。百炼须按地域／业务空间选择地址；方舟也可以填写自己的 ep-… 部署 ID。无需依赖模型列表接口。
3. API 类型和思考参数适配通常保持“自动”。选择是否思考及可用强度，点击“测试连接”。测试会发送少量诊断请求，可能计费，不读取或发送文库内容。
4. 保存后，可在聊天窗口顶部点击模型名称，从“已保存的模型配置”切换并“保存并使用”。每个配置独立保存地址、密钥、模型和设置。

默认配置可以在设置页选中已保存的配置后点击“设为默认”。聊天窗口的“保存并使用”只切换当前窗口；勾选“下次启动默认使用此平台和模型”才会同时更改默认配置。保存其他平台的 API 配置不会自动抢占默认项；首次保存时自动建立默认项。高级兼容参数和手动模型名称可展开填写，模型菜单支持搜索、方向键、Enter 和 Esc。

切换平台模板会清空表单中未保存的密钥，防止沿用到另一服务；原来保存的配置仍在。编辑配置后先保存再切换。运行中的任务结束后才能从聊天窗口切换模型。

## 自动适配范围

| 平台           | 地址模板                                          | 默认接口与模型适配                                                                                                     |
| -------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| DeepSeek 官方  | https://api.deepseek.com                          | Chat Completions；flash/pro 系列使用 thinking.type 与对应强度；保留工具历史中的空／非空 reasoning_content              |
| 火山方舟       | https://ark.cn-beijing.volces.com/api/v3          | Chat Completions；已识别 Seed / DeepSeek 模型采用 thinking.type；部分 Seed 系列支持 low / medium / high                |
| 阿里云百炼     | https://dashscope.aliyuncs.com/compatible-mode/v1 | Chat Completions；已识别 DeepSeek V4 与 Qwen 混合思考模型使用 enable_thinking；仅在适配规则支持时发送 reasoning_effort |
| OpenAI 官方    | https://api.openai.com/v1                         | GPT-5/6 等推理系列及已识别 o 系列自动使用 Responses；普通 GPT-4 系列默认 Chat Completions                              |
| 自定义兼容服务 | 手动填写                                          | 默认 Chat Completions，不臆测思考扩展参数；可以显式选择 API 类型和文档支持的思考参数                                   |

地址模板仅是起点。百炼的地域和业务空间地址（包括 \*.maas.aliyuncs.com）同样可识别；以控制台给出的地址为准，不要在 Base URL 后附加 /chat/completions 或 /responses。

你当前使用的 deepseek-v4.1-flash-1017，应选择百炼平台及对应的百炼地址，而不是 DeepSeek 官方平台。自动适配选择百炼参数。连接测试通过 API、思考（启用时）、工具调用与工具往返后，再进行实际文献任务验证。

方舟部署 ID 无法直接透露背后的模型。未知 ep-… 默认不附加思考参数；确认部署模型支持后，可以选择 thinking.type 适配来控制开关，或按文档选择仅 reasoning_effort。不要把一个模型的参数规则套用到所有部署。未知 Qwen 快照、仅思考模型和非文本模型也不能据平台名推断能力。

对于仅支持强度设置、没有适配开关的模型，不勾选强度设置表示使用服务默认值，不等于关闭思考。此时顶部显示“服务默认”。

## 连接诊断

- API：验证所选接口和流式方式能返回内容。
- 思考：启用且有明确适配规则时验证；OpenAI 不以返回可见思维链作为必要条件。
- 工具调用：要求模型返回一个无害的 diagnostic_echo 调用，核对名称及参数。
- 工具往返：将诊断结果按对应工具 ID 送回，要求完成回答。前一步失败时才跳过本步。

选择“自动工具协议”时，诊断仍明确测试原生工具，避免 JSON 降级掩盖原生能力缺失。显式选择 JSON actions 时，会明确显示 JSON 工具调用。一般优先使用原生工具。

服务器报告不支持某个思考参数时，不再误报成“不支持工具”。具体认证、余额、模型权限与地区错误仍需按服务返回的信息处理。

## Responses 和数据边界

Responses 适配转换函数定义、function_call 和 function_call_output，保持 call_id 配对。流式事件必须收到完整完成结果；不把半截响应当成功。当前运行所需的原始输出项及加密推理状态一并带回，计入已有上下文字符预算；不能容纳时报告预算错误，不静默截断。

OpenAI 请求显式设置 store=false；不依赖远端会话或 previous_response_id。对话和工具的本地执行、写操作审批、引用校验、检索排序、语义索引及预算数值均沿用现有机制。使用 Responses 不会启用供应商的联网搜索或远端文件工具。

## 验证范围

本版使用离线模拟响应和隔离 Zotero 原生测试验证请求格式、流式解析、工具历史、配置和布局。未用个人密钥向四个平台发送真实请求，不能据此保证所有模型、账户权限或服务端版本都通过。新模型可以手动输入，能力需通过连接测试确认。

## 官方接口依据

- [百炼 DeepSeek](https://help.aliyun.com/zh/model-studio/deepseek-api)
- [百炼深度思考](https://help.aliyun.com/zh/model-studio/deep-thinking)
- [百炼 Function Calling](https://help.aliyun.com/zh/model-studio/qwen-function-calling)
- [方舟 Chat API](https://docs.volcengine.com/docs/ark/chat-api?lang=zh)
- [方舟上下文管理](https://docs.volcengine.com/docs/ark/context-management?lang=zh)
- [OpenAI Responses 迁移](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [OpenAI 推理模型](https://developers.openai.com/api/docs/guides/reasoning)
