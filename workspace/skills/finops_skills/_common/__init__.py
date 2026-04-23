# -*- coding: utf-8 -*-
"""通用模块 - 提供跨平台的凭证获取等公共功能。"""

from .credential import get_credential, AliyunCredential

__all__ = ["get_credential", "AliyunCredential"]
