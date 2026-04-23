# -*- coding: utf-8 -*-
"""通用凭证管理模块 - 从环境变量获取阿里云凭证。

支持的环境变量（按优先级）：
- ALICLOUD_ACCESS_KEY + ALICLOUD_SECRET_KEY（推荐）
- ALIBABA_CLOUD_ACCESS_KEY_ID + ALIBABA_CLOUD_ACCESS_KEY_SECRET
- ALIYUN_ACCESS_KEY_ID + ALIYUN_ACCESS_KEY_SECRET

使用方式：
1. 设置环境变量：
   export ALIBABA_CLOUD_ACCESS_KEY_ID=your_access_key_id
   export ALIBABA_CLOUD_ACCESS_KEY_SECRET=your_access_key_secret

2. 在代码中获取凭证：
   from _common.credential import get_credential
   credential = get_credential()
   ak, sk = credential.access_key_id, credential.access_key_secret
"""

import os
from dataclasses import dataclass
from typing import Optional


@dataclass
class AliyunCredential:
    """阿里云凭证数据类。"""
    access_key_id: str
    access_key_secret: str
    security_token: Optional[str] = None

    def to_dict(self) -> dict:
        """转换为字典格式。"""
        return {
            "access_key_id": self.access_key_id,
            "access_key_secret": self.access_key_secret,
            "security_token": self.security_token,
        }


def get_credential() -> AliyunCredential:
    """从环境变量获取阿里云凭证。

    支持多种环境变量命名（按优先级）：
    1. ALICLOUD_ACCESS_KEY / ALICLOUD_SECRET_KEY（推荐）
    2. ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET
    3. ALIYUN_ACCESS_KEY_ID / ALIYUN_ACCESS_KEY_SECRET

    Returns:
        AliyunCredential 实例

    Raises:
        ValueError: 如果未设置必要的环境变量
    """
    ak = (
        os.environ.get("ALICLOUD_ACCESS_KEY")
        or os.environ.get("ALIBABA_CLOUD_ACCESS_KEY_ID")
        or os.environ.get("ALIYUN_ACCESS_KEY_ID")
        or ""
    )
    sk = (
        os.environ.get("ALICLOUD_SECRET_KEY")
        or os.environ.get("ALIBABA_CLOUD_ACCESS_KEY_SECRET")
        or os.environ.get("ALIYUN_ACCESS_KEY_SECRET")
        or ""
    )
    token = os.environ.get("ALICLOUD_SECURITY_TOKEN")

    if not ak or not sk:
        raise ValueError(
            "未设置阿里云凭证环境变量。请设置以下环境变量之一：\n"
            "  方式1: export ALICLOUD_ACCESS_KEY=xxx && export ALICLOUD_SECRET_KEY=xxx\n"
            "  方式2: export ALIBABA_CLOUD_ACCESS_KEY_ID=xxx && export ALIBABA_CLOUD_ACCESS_KEY_SECRET=xxx\n"
            "  方式3: export ALIYUN_ACCESS_KEY_ID=xxx && export ALIYUN_ACCESS_KEY_SECRET=xxx"
        )

    return AliyunCredential(
        access_key_id=ak,
        access_key_secret=sk,
        security_token=token,
    )


def validate_credential(credential: AliyunCredential) -> bool:
    """验证凭证格式是否有效（仅检查格式，不验证真实性）。

    Args:
        credential: 阿里云凭证

    Returns:
        True 如果格式有效，否则 False
    """
    if not credential.access_key_id or not credential.access_key_secret:
        return False
    if len(credential.access_key_id) < 10 or len(credential.access_key_secret) < 10:
        return False
    return True


def get_ak_sk(credential=None) -> tuple[str, str]:
    """获取 AK/SK 元组。

    如果未提供 credential，则从环境变量获取。
    支持 credential 为字典或 AliyunCredential 对象。

    Args:
        credential: 凭证对象或字典，为 None 时从环境变量获取

    Returns:
        (access_key_id, access_key_secret) 元组
    """
    if credential is None:
        cred = get_credential()
        return cred.access_key_id, cred.access_key_secret

    if isinstance(credential, AliyunCredential):
        return credential.access_key_id, credential.access_key_secret

    if isinstance(credential, dict):
        return credential["access_key_id"], credential["access_key_secret"]

    if hasattr(credential, "access_key_id"):
        return credential.access_key_id, credential.access_key_secret

    raise ValueError(f"无法识别的凭证类型: {type(credential)}")
