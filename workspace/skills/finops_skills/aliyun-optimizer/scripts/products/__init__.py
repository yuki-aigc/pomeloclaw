# -*- coding: utf-8 -*-
"""云资源成本优化通用框架 - 产品配置层。

各产品配置模块：
- ECS: 云服务器
- RDS: 云数据库
- EBS: 云盘
- EIP: 弹性公网 IP
- SLB: 负载均衡
- CDN: 内容分发网络
- Redis: 云数据库 Redis 版
- NAT: NAT 网关
- NAS: 文件存储
# - OSS: 对象存储 (已移除)
- SLS: 日志服务
- DRDS: PolarDB-X 分布式版
- MSE: 微服务引擎
- Elasticsearch: 检索分析服务
- RocketMQ: 消息队列
# - Hologres: 实时数仓 (已移除)
- ARMS: 应用实时监控服务
- MaxCompute: 大数据计算服务
- WAF: Web应用防火墙
"""

from typing import Dict, Callable, Any, Coroutine, Optional

from core.base import ProductConfig

# 产品注册表
_PRODUCT_REGISTRY: Dict[str, ProductConfig] = {}


def register_product(config: ProductConfig) -> None:
    """注册产品配置。
    
    Args:
        config: 产品配置
    """
    _PRODUCT_REGISTRY[config.product_code] = config


def get_product_config(product_code: str) -> Optional[ProductConfig]:
    """获取产品配置。
    
    Args:
        product_code: 产品代码
    
    Returns:
        产品配置，未注册返回 None
    """
    return _PRODUCT_REGISTRY.get(product_code)


def list_products() -> list[str]:
    """列出所有已注册的产品代码。"""
    return list(_PRODUCT_REGISTRY.keys())


def get_all_configs() -> Dict[str, ProductConfig]:
    """获取所有产品配置。"""
    return _PRODUCT_REGISTRY.copy()


# 导入各产品模块，触发自动注册
from products import ecs
from products import rds
from products import ebs
from products import eip
from products import slb
from products import cdn
from products import redis
from products import nat
from products import nas
from products import sls
from products import drds
from products import mse
from products import elasticsearch
from products import rocketmq
from products import arms
from products import maxcompute
from products import waf

# 导出 ECS 特有函数
from products.ecs import (
    get_downscaling_instances,
    get_ecs_recommend_spec,
    list_ecs_instances,
)

__all__ = [
    "register_product",
    "get_product_config",
    "list_products",
    "get_all_configs",
    # ECS 特有函数
    "get_downscaling_instances",
    "get_ecs_recommend_spec",
    "list_ecs_instances",
]
