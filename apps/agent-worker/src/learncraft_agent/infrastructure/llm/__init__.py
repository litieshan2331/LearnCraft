"""托管模型 Provider 适配包。

当前包含 SafeModelEgressClient 及其工厂：后续 OpenAI-compatible ModelGateway 必须通过该客户端访问外部模型，
从而复用 URL/DNS/IP 校验、固定 IP 连接、审计、超时和响应大小限制。
"""
