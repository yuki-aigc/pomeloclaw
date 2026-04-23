# -*- coding: utf-8 -*-
"""云资源成本优化通用框架 - BSS 询价/账单服务 + OpenAPI 询价。

三级价格查询策略：
1. BSS 询价（优先，最准确）
2. 产品 OpenAPI 询价（ECS DescribePrice, RDS DescribePrice 等）
3. 估算价格（最后 fallback）

封装阿里云 BSS OpenAPI：
- GetPayAsYouGoPrice: 按量付费询价
- GetSubscriptionPrice: 包年包月询价
- DescribeInstanceBill: 实例级账单查询
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from alibabacloud_tea_openapi.models import Config
from alibabacloud_bssopenapi20171214.client import Client as BssClient
from alibabacloud_bssopenapi20171214 import models as bss_models

# 延迟导入产品 SDK以避免循环依赖
try:
    from alibabacloud_ecs20140526.client import Client as EcsClient
    from alibabacloud_ecs20140526 import models as ecs_models
    HAS_ECS_SDK = True
except ImportError:
    HAS_ECS_SDK = False

try:
    from alibabacloud_rds20140815.client import Client as RdsClient
    from alibabacloud_rds20140815 import models as rds_models
    HAS_RDS_SDK = True
except ImportError:
    HAS_RDS_SDK = False

try:
    from alibabacloud_r_kvstore20150101.client import Client as RedisClient
    from alibabacloud_r_kvstore20150101 import models as redis_models
    HAS_REDIS_SDK = True
except ImportError:
    HAS_REDIS_SDK = False

try:
    from alibabacloud_slb20140515.client import Client as SlbClient
    from alibabacloud_slb20140515 import models as slb_models
    HAS_SLB_SDK = True
except ImportError:
    HAS_SLB_SDK = False

try:
    from alibabacloud_vpc20160428.client import Client as VpcClient
    from alibabacloud_vpc20160428 import models as vpc_models
    HAS_VPC_SDK = True
except ImportError:
    HAS_VPC_SDK = False

logger = logging.getLogger(__name__)


def _safe_float(value) -> float:
    """安全转换为 float。"""
    try:
        return float(value) if value is not None else 0.0
    except (ValueError, TypeError):
        return 0.0


class BssService:
    """BSS 询价/账单服务。
    
    封装阿里云 BSS OpenAPI，提供统一的询价和账单查询接口。
    支持国内站和国际站自动切换。
    
    Usage:
        bss = BssService(access_key_id, access_key_secret)
        
        # 按量付费询价
        price = await bss.get_payg_price("cn-hangzhou", "ecs.g6.large", "ecs", "InstanceType")
        
        # 包年包月询价
        price = await bss.get_subscription_price("cn-hangzhou", "ecs.g6.large", "ecs", "InstanceType")
        
        # 查询账单
        cost = await bss.query_instance_bill("i-xxxx", "ecs")
    """
    
    # 国内站端点
    ENDPOINT_CN = "business.aliyuncs.com"
    # 国际站端点
    ENDPOINT_INTL = "business.ap-southeast-1.aliyuncs.com"
    
    def __init__(
        self,
        access_key_id: str,
        access_key_secret: str,
        endpoint: str = ENDPOINT_CN,
    ):
        """初始化 BSS 服务。
        
        Args:
            access_key_id: AK
            access_key_secret: SK
            endpoint: BSS 端点，默认国内站
        """
        self._ak = access_key_id
        self._sk = access_key_secret
        self._endpoint = endpoint
        self._client = self._build_client(endpoint)
    
    def _build_client(self, endpoint: str) -> BssClient:
        """构建 BSS 客户端。"""
        config = Config(
            access_key_id=self._ak,
            access_key_secret=self._sk,
            endpoint=endpoint,
        )
        return BssClient(config)
    
    def _build_ecs_modules_payg(self, spec: str, region_id: str) -> list:
        """构建 ECS 按量付费询价的 Module 列表。"""
        return [
            bss_models.GetPayAsYouGoPriceRequestModuleList(
                module_code="InstanceType",
                config=f"InstanceType:{spec},IoOptimized:IoOptimized,ImageOs:linux",
                price_type="Hour",
            ),
            bss_models.GetPayAsYouGoPriceRequestModuleList(
                module_code="SystemDisk",
                config="SystemDisk.Category:cloud_essd,SystemDisk.Size:40,SystemDisk.PerformanceLevel:PL0",
                price_type="Hour",
            ),
        ]
    
    def _build_slb_modules_payg(self, spec: str, region_id: str) -> list:
        """构建 SLB 按量付费询价的 Module 列表。"""
        # 从规格名解析 SLB 规格代码
        slb_spec = spec if spec.startswith("slb.") else "slb.s2.small"
        return [
            bss_models.GetPayAsYouGoPriceRequestModuleList(
                module_code="LoadBalancerSpec",
                config=f"LoadBalancerSpec:{slb_spec}",
                price_type="Hour",
            ),
            bss_models.GetPayAsYouGoPriceRequestModuleList(
                module_code="InternetTrafficOut",
                config="InternetTrafficOut:1",
                price_type="Usage",
            ),
            bss_models.GetPayAsYouGoPriceRequestModuleList(
                module_code="InstanceRent",
                config="InstanceRent:1",
                price_type="Hour",
            ),
        ]
    
    def _build_rds_modules_payg(self, spec: str, region_id: str) -> tuple[list, str]:
        """构建 RDS 按量付费询价的 Module 列表。
        
        关键配置说明（基于 DescribePricingModule API 返回）：
        - DBInstanceClass: ['EngineVersion', 'DBInstanceClass', 'Region']
        - DBInstanceStorage: ['Series', 'EngineVersion', 'DBInstanceStorage', 'Region', 'DBInstanceStorageType']
        
        Returns:
            (module_list, product_type): RDS 按量付费用 bards
        """
        # 规格名格式标准化
        rds_spec = spec if "." in spec else f"mysql.n2.{spec}"
        return (
            [
                bss_models.GetPayAsYouGoPriceRequestModuleList(
                    module_code="DBInstanceClass",
                    price_type="Hour",
                    config=f"EngineVersion:8.0,DBInstanceClass:{rds_spec},Region:{region_id}",
                ),
                bss_models.GetPayAsYouGoPriceRequestModuleList(
                    module_code="DBInstanceStorage",
                    price_type="Hour",
                    config=f"Series:HighAvailability,EngineVersion:8.0,DBInstanceStorage:20,Region:{region_id},DBInstanceStorageType:cloud_essd",
                ),
            ],
            "bards",  # RDS 按量付费用 bards（不是 rords！）
        )
    
    def _build_eip_modules_payg(self, spec: str, region_id: str) -> list:
        """构建 EIP 按量付费询价的 Module 列表。
        
        Args:
            spec: 带宽 (Mbps)，如 "5" 表示 5Mbps
        """
        # 带宽转换为 Kbps，最小 1024
        try:
            bandwidth_mbps = int(spec)
            bandwidth_kbps = max(1024, bandwidth_mbps * 1024)
        except ValueError:
            bandwidth_kbps = 1024
        
        return [
            bss_models.GetPayAsYouGoPriceRequestModuleList(
                module_code="Bandwidth",
                config=f"Bandwidth:{bandwidth_kbps}",
                price_type="Day",
            ),
            bss_models.GetPayAsYouGoPriceRequestModuleList(
                module_code="InternetChargeType",
                config="InternetChargeType:1",  # 按流量计费
                price_type="Usage",
            ),
            bss_models.GetPayAsYouGoPriceRequestModuleList(
                module_code="ISP",
                config="ISP:BGP",
                price_type="Hour",
            ),
        ]
    
    def _build_disk_modules_payg(self, spec: str, region_id: str, size: int = 100) -> tuple[list, str]:
        """构建云盘 (EBS) 按量付费询价的 Module 列表。
        
        Args:
            spec: 云盘类型 (cloud_essd/cloud_ssd/cloud_efficiency)
            size: 云盘大小 GB
        
        Returns:
            (module_list, product_code): 云盘使用 yundisk 产品代码
        """
        disk_category = spec if spec.startswith("cloud_") else "cloud_essd"
        return (
            [
                bss_models.GetPayAsYouGoPriceRequestModuleList(
                    module_code="DataDisk",
                    config=f"DataDisk.Size:{size},DataDisk.Category:{disk_category}",
                    price_type="Hour",
                ),
            ],
            "yundisk",  # 云盘使用 yundisk 产品代码
        )
    
    async def get_payg_price(
        self,
        region_id: str,
        spec: str,
        product_code: str,
        module_code: str = "",
        config_template: str = "",
    ) -> float:
        """按量付费询价（返回月费）。
        
        使用 GetPayAsYouGoPrice API 获取真实价格。
        API 返回小时价，自动换算为月价：月价 = 小时价 × 24 × 30
        
        Args:
            region_id: 地域 ID
            spec: 规格名称
            product_code: 产品代码（ecs, rds, slb 等）
            module_code: 模块代码（兼容旧接口，新逻辑自动构建）
            config_template: 配置模板（兼容旧接口）
        
        Returns:
            月费（元），失败返回 -1
        """
        try:
            # 根据产品类型自动构建正确的 Module 列表
            product_lower = product_code.lower()
            product_type = None  # RDS 需要额外的 product_type
            
            if product_lower == "ecs":
                module_list = self._build_ecs_modules_payg(spec, region_id)
            elif product_lower == "slb":
                module_list = self._build_slb_modules_payg(spec, region_id)
            elif product_lower in ("rds", "rds_mysql"):
                module_list, product_type = self._build_rds_modules_payg(spec, region_id)
            elif product_lower == "eip":
                module_list = self._build_eip_modules_payg(spec, region_id)
            elif product_lower in ("disk", "ebs", "yundisk"):
                module_list, actual_product_code = self._build_disk_modules_payg(spec, region_id)
                product_code = actual_product_code  # 云盘用 yundisk
            else:
                # 通用 fallback：简单配置
                config_str = f"{module_code}:{spec}" if module_code else f"InstanceType:{spec}"
                module_list = [
                    bss_models.GetPayAsYouGoPriceRequestModuleList(
                        module_code=module_code or "InstanceType",
                        config=config_str,
                        price_type="Hour",
                    )
                ]
            
            req = bss_models.GetPayAsYouGoPriceRequest(
                product_code=product_code,
                product_type=product_type,
                subscription_type="PayAsYouGo",
                region=region_id,
                module_list=module_list,
            )
            resp = await asyncio.to_thread(self._client.get_pay_as_you_go_price, req)
            body = resp.body
            
            if body.data and body.data.module_details and body.data.module_details.module_detail:
                total_hour_price = 0.0
                for detail in body.data.module_details.module_detail:
                    # 优先取优惠价，否则取原价
                    invoice_discount = _safe_float(detail.invoice_discount)
                    if invoice_discount > 0:
                        hour_price = _safe_float(detail.cost_after_discount)
                    else:
                        hour_price = _safe_float(detail.original_cost)
                    total_hour_price += hour_price
                # 小时价转月价（累加所有 Module 价格）
                if total_hour_price > 0:
                    return total_hour_price * 24 * 30
            
            logger.warning("BSS GetPayAsYouGoPrice 返回空数据: %s %s", product_code, spec)
            return -1.0
        
        except Exception as e:
            error_msg = str(e)
            # 国际账号适配：自动切换端点重试
            if "NotApplicable" in error_msg and "regionId" in error_msg.lower():
                if self._endpoint == self.ENDPOINT_CN:
                    logger.info("BSS API 返回 NotApplicable，切换到国际站端点重试")
                    self._endpoint = self.ENDPOINT_INTL
                    self._client = self._build_client(self.ENDPOINT_INTL)
                    return await self.get_payg_price(
                        region_id, spec, product_code, module_code, config_template
                    )
            
            logger.warning("BSS GetPayAsYouGoPrice failed: %s %s: %s", product_code, spec, e)
            return -1.0
    
    def _build_ecs_modules_sub(self, spec: str, region_id: str) -> list:
        """构建 ECS 包年包月询价的 Module 列表。"""
        return [
            bss_models.GetSubscriptionPriceRequestModuleList(
                module_code="InstanceType",
                config=f"InstanceType:{spec},IoOptimized:IoOptimized,ImageOs:linux",
            ),
            bss_models.GetSubscriptionPriceRequestModuleList(
                module_code="SystemDisk",
                config="SystemDisk.Category:cloud_essd,SystemDisk.Size:40,SystemDisk.PerformanceLevel:PL0",
            ),
        ]
    
    def _build_slb_modules_sub(self, spec: str, region_id: str) -> list:
        """构建 SLB 包年包月询价的 Module 列表。"""
        slb_spec = spec if spec.startswith("slb.") else "slb.s2.small"
        return [
            bss_models.GetSubscriptionPriceRequestModuleList(
                module_code="LoadBalancerSpec",
                config=f"LoadBalancerSpec:{slb_spec}",
            ),
            bss_models.GetSubscriptionPriceRequestModuleList(
                module_code="InternetTrafficOut",
                config="InternetTrafficOut:1",
            ),
            bss_models.GetSubscriptionPriceRequestModuleList(
                module_code="InstanceRent",
                config="InstanceRent:1",
            ),
        ]
    
    def _build_rds_modules_sub(self, spec: str, region_id: str) -> tuple[list, str]:
        """构建 RDS 包年包月询价的 Module 列表。
        
        Returns:
            (module_list, product_type): RDS 需要额外的 product_type 参数
        """
        rds_spec = spec if "." in spec else f"mysql.n2.{spec}"
        return (
            [
                bss_models.GetSubscriptionPriceRequestModuleList(
                    module_code="Engine",
                    config="Engine:mysql",
                ),
                bss_models.GetSubscriptionPriceRequestModuleList(
                    module_code="EngineVersion",
                    config="EngineVersion:8.0",
                ),
                bss_models.GetSubscriptionPriceRequestModuleList(
                    module_code="DBNetworkType",
                    config="DBNetworkType:1",
                ),
                bss_models.GetSubscriptionPriceRequestModuleList(
                    module_code="DBInstanceClass",
                    config=f"DBInstanceClass:{rds_spec}",
                ),
                bss_models.GetSubscriptionPriceRequestModuleList(
                    module_code="DBInstanceStorage",
                    config="DBInstanceStorage:20",
                ),
            ],
            "rords",
        )
    
    async def get_subscription_price(
        self,
        region_id: str,
        spec: str,
        product_code: str,
        module_code: str = "",
        config_template: str = "",
        period_months: int = 1,
    ) -> float:
        """包年包月询价（返回月费）。
        
        使用 GetSubscriptionPrice API 获取预付费价格。
        
        Args:
            region_id: 地域 ID
            spec: 规格名称
            product_code: 产品代码
            module_code: 模块代码（兼容旧接口）
            config_template: 配置模板（兼容旧接口）
            period_months: 订购周期（月）
        
        Returns:
            月费（元），失败返回 -1
        """
        try:
            # 根据产品类型自动构建正确的 Module 列表
            product_lower = product_code.lower()
            product_type = None  # RDS 需要额外的 product_type
            
            if product_lower == "ecs":
                module_list = self._build_ecs_modules_sub(spec, region_id)
            elif product_lower == "slb":
                module_list = self._build_slb_modules_sub(spec, region_id)
            elif product_lower in ("rds", "rds_mysql"):
                module_list, product_type = self._build_rds_modules_sub(spec, region_id)
            else:
                # 通用 fallback
                config_str = f"{module_code}:{spec}" if module_code else f"InstanceType:{spec}"
                module_list = [
                    bss_models.GetSubscriptionPriceRequestModuleList(
                        module_code=module_code or "InstanceType",
                        config=config_str,
                    )
                ]
            
            req = bss_models.GetSubscriptionPriceRequest(
                product_code=product_code,
                product_type=product_type,
                subscription_type="Subscription",
                order_type="NewOrder",
                service_period_quantity=period_months,
                service_period_unit="Month",
                quantity=1,
                region=region_id,
                module_list=module_list,
            )
            resp = await asyncio.to_thread(self._client.get_subscription_price, req)
            body = resp.body
            
            if body.data:
                discount_price = _safe_float(body.data.discount_price)
                if discount_price > 0:
                    return _safe_float(body.data.trade_price) / period_months
                original = _safe_float(body.data.original_price)
                if original > 0:
                    return original / period_months
            
            logger.warning("BSS GetSubscriptionPrice 返回空数据: %s %s", product_code, spec)
            return -1.0
        
        except Exception as e:
            error_msg = str(e)
            if "NotApplicable" in error_msg and "regionId" in error_msg.lower():
                if self._endpoint == self.ENDPOINT_CN:
                    logger.info("BSS API 返回 NotApplicable，切换到国际站端点重试")
                    self._endpoint = self.ENDPOINT_INTL
                    self._client = self._build_client(self.ENDPOINT_INTL)
                    return await self.get_subscription_price(
                        region_id, spec, product_code, module_code, config_template, period_months
                    )
            
            logger.warning("BSS GetSubscriptionPrice failed: %s %s: %s", product_code, spec, e)
            return -1.0
    
    async def query_instance_bill(
        self,
        instance_id: str,
        product_code: str,
        billing_cycle: str = "",
    ) -> float:
        """查询实例级月度账单（costBefore）。
        
        使用 DescribeInstanceBill API 获取历史账单。
        
        账期自动计算规则：
        - 每月 4 号及以后：取上月
        - 每月 1~3 号：取前 2 个月（上月账单可能未出）
        
        Args:
            instance_id: 实例 ID
            product_code: 产品代码
            billing_cycle: 账期（YYYY-MM），空则自动计算
        
        Returns:
            月费用（元），无账单返回 0
        """
        # 自动计算账期
        if not billing_cycle:
            now = datetime.now(timezone.utc)
            if now.day >= 4:
                # 取上个月
                target_date = now.replace(day=1) - timedelta(days=1)
            else:
                # 取前 2 个月
                target_date = (now.replace(day=1) - timedelta(days=1)).replace(day=1) - timedelta(days=1)
            billing_cycle = target_date.strftime("%Y-%m")
        
        total_cost = 0.0
        try:
            next_token: Optional[str] = None
            while True:
                req = bss_models.DescribeInstanceBillRequest(
                    billing_cycle=billing_cycle,
                    product_code=product_code,
                    instance_id=instance_id,
                    granularity="MONTHLY",
                    max_results=300,
                    next_token=next_token,
                )
                resp = await asyncio.to_thread(self._client.describe_instance_bill, req)
                body = resp.body
                
                if body.data and body.data.items:
                    for item in body.data.items:
                        # 过滤退款和调账
                        bill_type = item.item or ""
                        if bill_type in ("Refund", "Adjustment"):
                            continue
                        pretax_amount = _safe_float(item.pretax_amount)
                        if pretax_amount <= 0:
                            continue
                        total_cost += pretax_amount
                
                next_token = body.data.next_token if body.data else None
                if not next_token:
                    break
        
        except Exception as e:
            logger.warning("BSS DescribeInstanceBill failed for %s: %s", instance_id, e)
        
        return total_cost
    
    # =========================================================================
    # OpenAPI 询价方法（作为 BSS 询价失败后的中间层 fallback）
    # =========================================================================
    
    async def _openapi_ecs_price(
        self,
        region_id: str,
        spec: str,
        charge_type: str = "PostPaid",
    ) -> float:
        """使用 ECS DescribePrice API 询价。
        
        Args:
            region_id: 地域 ID
            spec: ECS 规格
            charge_type: PostPaid(按量) / PrePaid(包月)
        
        Returns:
            月费（元），失败返回 -1
        """
        if not HAS_ECS_SDK:
            return -1.0
        
        config = Config(
            access_key_id=self._ak,
            access_key_secret=self._sk,
            endpoint=f"ecs.{region_id}.aliyuncs.com",
        )
        client = EcsClient(config)
        
        # 尝试多种系统盘类型，应对不同实例规格的兼容性问题
        disk_categories = ["cloud_essd", "cloud_ssd", "cloud_efficiency", "cloud"]
        
        for disk_category in disk_categories:
            try:
                req = ecs_models.DescribePriceRequest(
                    region_id=region_id,
                    resource_type="instance",
                    instance_type=spec,
                    io_optimized="optimized",
                    instance_network_type="vpc",
                    system_disk=ecs_models.DescribePriceRequestSystemDisk(
                        category=disk_category,
                        size=40,
                    ),
                    price_unit="Hour" if charge_type == "PostPaid" else "Month",
                )
                
                resp = await asyncio.to_thread(client.describe_price, req)
                body = resp.body
                
                if body.price_info and body.price_info.price:
                    price = body.price_info.price
                    trade_price = _safe_float(price.trade_price)
                    if trade_price <= 0:
                        trade_price = _safe_float(price.original_price)
                    
                    if charge_type == "PostPaid" and trade_price > 0:
                        trade_price = trade_price * 24 * 30
                    
                    if trade_price > 0:
                        logger.info("ECS OpenAPI 询价成功: %s -> %.2f 元/月", spec, trade_price)
                        return trade_price
            
            except Exception as e:
                error_msg = str(e)
                if "InvalidSystemDiskCategory" in error_msg:
                    continue
                logger.warning("ECS DescribePrice failed: %s %s: %s", region_id, spec, e)
                break
        
        return -1.0
    
    async def _openapi_rds_price(
        self,
        region_id: str,
        spec: str,
        charge_type: str = "Postpaid",
        engine: str = "MySQL",
        engine_version: str = "8.0",
        storage: int = 20,
    ) -> float:
        """使用 RDS DescribePrice API 询价。
        
        Args:
            region_id: 地域 ID
            spec: RDS 规格
            charge_type: Postpaid(按量) / Prepaid(包月)
            engine: 数据库引擎
            engine_version: 引擎版本
            storage: 存储空间 GB
        
        Returns:
            月费（元），失败返回 -1
        """
        if not HAS_RDS_SDK:
            return -1.0
        
        try:
            config = Config(
                access_key_id=self._ak,
                access_key_secret=self._sk,
                endpoint=f"rds.{region_id}.aliyuncs.com",
            )
            client = RdsClient(config)
            
            # 构建请求
            commodity_code = "bards" if charge_type == "Postpaid" else "rds"
            req = rds_models.DescribePriceRequest(
                region_id=region_id,
                commodity_code=commodity_code,
                engine=engine,
                engine_version=engine_version,
                dbinstance_class=spec,
                dbinstance_storage=storage,
                dbinstance_storage_type="cloud_essd",
                pay_type=charge_type,
                quantity=1,
                order_type="BUY",
            )
            
            # 包月需要额外参数
            if charge_type == "Prepaid":
                req.time_type = "Month"
                req.used_time = 1
            
            resp = await asyncio.to_thread(client.describe_price, req)
            body = resp.body
            
            if body.price_info:
                # 优先取交易价，否则取原价
                trade_price = _safe_float(body.price_info.trade_price)
                if trade_price <= 0:
                    trade_price = _safe_float(body.price_info.original_price)
                
                # 按量付费返回的是小时价，转换为月价
                if charge_type == "Postpaid" and trade_price > 0:
                    trade_price = trade_price * 24 * 30
                
                if trade_price > 0:
                    logger.info("RDS OpenAPI 询价成功: %s -> %.2f 元/月", spec, trade_price)
                    return trade_price
            
            return -1.0
        
        except Exception as e:
            logger.warning("RDS DescribePrice failed: %s %s: %s", region_id, spec, e)
            return -1.0
    
    async def _openapi_disk_price(
        self,
        region_id: str,
        disk_category: str = "cloud_essd",
        size: int = 100,
        charge_type: str = "PostPaid",
    ) -> float:
        """使用 ECS DescribePrice API 查询云盘价格。
        
        Args:
            region_id: 地域 ID
            disk_category: 云盘类型 (cloud_essd/cloud_ssd/cloud_efficiency)
            size: 云盘大小 GB
            charge_type: PostPaid/PrePaid
        
        Returns:
            月费（元），失败返回 -1
        """
        if not HAS_ECS_SDK:
            return -1.0
        
        try:
            config = Config(
                access_key_id=self._ak,
                access_key_secret=self._sk,
                endpoint=f"ecs.{region_id}.aliyuncs.com",
            )
            client = EcsClient(config)
            
            # 构建 DataDisk 请求
            data_disk = ecs_models.DescribePriceRequestDataDisk(
                category=disk_category,
                size=size,
            )
            if disk_category == "cloud_essd":
                data_disk.performance_level = "PL0"
            
            req = ecs_models.DescribePriceRequest(
                region_id=region_id,
                resource_type="disk",
                data_disk=[data_disk],
                price_unit="Hour" if charge_type == "PostPaid" else "Month",
            )
            
            resp = await asyncio.to_thread(client.describe_price, req)
            body = resp.body
            
            if body.price_info and body.price_info.price:
                price = body.price_info.price
                trade_price = _safe_float(price.trade_price)
                if trade_price <= 0:
                    trade_price = _safe_float(price.original_price)
                
                # 小时价转月价
                if charge_type == "PostPaid" and trade_price > 0:
                    trade_price = trade_price * 24 * 30
                
                if trade_price > 0:
                    logger.info("EBS OpenAPI 询价成功: %s %dGB -> %.2f 元/月", disk_category, size, trade_price)
                    return trade_price
            
            return -1.0
        
        except Exception as e:
            logger.warning("EBS DescribePrice failed: %s %s: %s", region_id, disk_category, e)
            return -1.0
    
    async def _openapi_redis_price(
        self,
        region_id: str,
        spec: str,
        capacity: int = 1024,
        charge_type: str = "PostPaid",
    ) -> float:
        """使用 Redis DescribePrice API 询价。
        
        Args:
            region_id: 地域 ID
            spec: Redis 规格（如 redis.master.small.default）
            capacity: 内存容量 MB
            charge_type: PostPaid/PrePaid
        
        Returns:
            月费（元），失败返回 -1
        """
        if not HAS_REDIS_SDK:
            return -1.0
        
        try:
            config = Config(
                access_key_id=self._ak,
                access_key_secret=self._sk,
                endpoint=f"r-kvstore.{region_id}.aliyuncs.com",
            )
            client = RedisClient(config)
            
            req = redis_models.DescribePriceRequest(
                region_id=region_id,
                capacity=capacity,
                instance_class=spec,
                charge_type=charge_type,
                node_type="MASTER_SLAVE",
                quantity=1,
                order_type="BUY",
            )
            
            resp = await asyncio.to_thread(client.describe_price, req)
            body = resp.body
            
            # 获取价格（修复：检查 body.order 而不是 body.order.coupons）
            if body.order:
                # 优先取成交价，否则取原价
                trade_price = _safe_float(body.order.trade_price)
                if trade_price <= 0:
                    trade_price = _safe_float(body.order.original_price)
                
                # 按量付费是小时价，转换为月价
                if charge_type == "PostPaid" and trade_price > 0:
                    trade_price = trade_price * 24 * 30
                
                if trade_price > 0:
                    logger.info("Redis OpenAPI 询价成功: %s -> %.2f 元/月", spec, trade_price)
                    return trade_price
            
            return -1.0
        
        except Exception as e:
            logger.warning("Redis DescribePrice failed: %s %s: %s", region_id, spec, e)
            return -1.0
    
    async def _openapi_slb_price(
        self,
        region_id: str,
        spec: str = "slb.s2.small",
        charge_type: str = "PostPaid",
    ) -> float:
        """使用 SLB DescribePrice API 询价。
        
        注意：SLB 没有 DescribePrice API，使用估算价格。
        
        Args:
            region_id: 地域 ID
            spec: SLB 规格
            charge_type: PostPaid/PrePaid
        
        Returns:
            月费（元），失败返回 -1
        """
        # SLB 没有 DescribePrice API，使用价格表估算
        slb_price_map = {
            "slb.s1.small": 72,
            "slb.s2.small": 144,
            "slb.s2.medium": 216,
            "slb.s3.small": 288,
            "slb.s3.medium": 432,
            "slb.s3.large": 576,
        }
        
        spec_lower = spec.lower()
        for key, price in slb_price_map.items():
            if key in spec_lower or spec_lower in key:
                logger.info("SLB 价格表查询: %s -> %.2f 元/月", spec, price)
                return float(price)
        
        # 默认价格
        return 144.0
    
    async def _openapi_nat_price(
        self,
        region_id: str,
        spec: str = "Small",
        charge_type: str = "PostPaid",
    ) -> float:
        """使用 NAT 网关估算价格。
        
        注意：NAT 网关没有统一的 DescribePrice API，使用价格表估算。
        
        Args:
            region_id: 地域 ID
            spec: NAT 规格（Small/Middle/Large/XLarge.1）
            charge_type: PostPaid/PrePaid
        
        Returns:
            月费（元），失败返回 -1
        """
        # NAT 网关价格表（按量付费月费，含 CU 基础费用）
        nat_price_map = {
            "small": 216,  # 小型
            "middle": 432,  # 中型
            "large": 864,  # 大型
            "xlarge.1": 1296,  # 超大型
        }
        
        spec_lower = spec.lower()
        for key, price in nat_price_map.items():
            if key in spec_lower:
                logger.info("NAT 价格表查询: %s -> %.2f 元/月", spec, price)
                return float(price)
        
        # 默认价格
        return 216.0
    
    async def get_price_with_fallback(
        self,
        region_id: str,
        spec: str,
        product_code: str,
        charge_type: str = "PostPaid",
    ) -> tuple[float, str]:
        """三级价格查询：BSS -> OpenAPI -> 估算。
        
        Args:
            region_id: 地域 ID
            spec: 规格名称
            product_code: 产品代码 (ecs/rds/slb/redis/nat...)
            charge_type: PostPaid/PrePaid
        
        Returns:
            (price, source): 价格和来源标记 (bss/openapi/estimate)
        """
        product_lower = product_code.lower()
        is_payg = charge_type in ("PostPaid", "Postpaid", "payasyougo")
        
        # 第一级：BSS 询价
        if is_payg:
            price = await self.get_payg_price(region_id, spec, product_code)
        else:
            price = await self.get_subscription_price(region_id, spec, product_code)
        
        if price > 0:
            return (price, "bss")
        
        # 第二级：OpenAPI 询价（根据产品类型调用不同的询价方法）
        price = -1.0
        
        if product_lower == "ecs":
            price = await self._openapi_ecs_price(
                region_id, spec, 
                "PostPaid" if is_payg else "PrePaid"
            )
        elif product_lower in ("rds", "rds_mysql"):
            price = await self._openapi_rds_price(
                region_id, spec,
                "Postpaid" if is_payg else "Prepaid"
            )
        elif product_lower in ("disk", "ebs", "yundisk"):
            price = await self._openapi_disk_price(
                region_id, spec,
                charge_type="PostPaid" if is_payg else "PrePaid"
            )
        elif product_lower in ("redis", "r-kvstore", "kvstore"):
            price = await self._openapi_redis_price(
                region_id, spec,
                charge_type="PostPaid" if is_payg else "PrePaid"
            )
        elif product_lower == "slb":
            price = await self._openapi_slb_price(
                region_id, spec,
                charge_type="PostPaid" if is_payg else "PrePaid"
            )
        elif product_lower in ("nat", "natgateway", "nat_gateway"):
            price = await self._openapi_nat_price(
                region_id, spec,
                charge_type="PostPaid" if is_payg else "PrePaid"
            )
        
        if price > 0:
            return (price, "openapi")
        
        # 第三级：估算价格
        price = self._estimate_price(spec, product_lower)
        logger.warning("BSS & OpenAPI 询价失败，使用估算价格: %s %s -> %.2f", product_code, spec, price)
        return (price, "estimate")
    
    # ECS 规格参考价格表（按量付费月费，基于 cn-hangzhou 区域）
    # 价格来源：阿里云官网定价 2024
    ECS_PRICE_TABLE: dict[str, float] = {
        # 通用型 g6/g7
        "ecs.g6.large": 378, "ecs.g6.xlarge": 756, "ecs.g6.2xlarge": 1512, "ecs.g6.4xlarge": 3024,
        "ecs.g7.large": 420, "ecs.g7.xlarge": 840, "ecs.g7.2xlarge": 1680, "ecs.g7.4xlarge": 3360,
        # 计算型 c6/c7
        "ecs.c6.large": 300, "ecs.c6.xlarge": 600, "ecs.c6.2xlarge": 1200, "ecs.c6.4xlarge": 2400,
        "ecs.c7.large": 336, "ecs.c7.xlarge": 672, "ecs.c7.2xlarge": 1344, "ecs.c7.4xlarge": 2688,
        # 内存型 r6/r7
        "ecs.r6.large": 456, "ecs.r6.xlarge": 912, "ecs.r6.2xlarge": 1824, "ecs.r6.4xlarge": 3648,
        "ecs.r7.large": 500, "ecs.r7.xlarge": 1000, "ecs.r7.2xlarge": 2000, "ecs.r7.4xlarge": 4000,
        # 经济型 e 系列
        "ecs.e-c1m1.large": 180, "ecs.e-c1m1.xlarge": 360, "ecs.e-c1m1.2xlarge": 720,
        "ecs.e-c1m2.large": 240, "ecs.e-c1m2.xlarge": 480, "ecs.e-c1m2.2xlarge": 960,
        "ecs.e-c1m4.large": 350, "ecs.e-c1m4.xlarge": 700, "ecs.e-c1m4.2xlarge": 1400,
        # 突发性能型 t5/t6
        "ecs.t5-lc1m1.small": 72, "ecs.t5-lc1m2.small": 90, "ecs.t5-lc1m2.large": 180,
        "ecs.t6-c1m1.large": 144, "ecs.t6-c1m2.large": 180, "ecs.t6-c1m4.large": 252,
        # 共享型 s6
        "ecs.s6-c1m1.small": 60, "ecs.s6-c1m2.small": 75, "ecs.s6-c1m2.large": 150,
        # 企业级入门 n4
        "ecs.n4.small": 90, "ecs.n4.large": 180, "ecs.n4.xlarge": 360, "ecs.n4.2xlarge": 720,
    }
    
    # RDS 规格参考价格表（按量付费月费）
    RDS_PRICE_TABLE: dict[str, float] = {
        # MySQL 通用规格
        "mysql.n2.small.1": 280, "mysql.n2.medium.1": 480, "mysql.n2.large.1": 780,
        "mysql.n4.medium.1": 580, "mysql.n4.large.1": 980, "mysql.n4.xlarge.1": 1580,
        "rds.mysql.s1.small": 280, "rds.mysql.s2.large": 480, "rds.mysql.m1.medium": 780,
        # PostgreSQL
        "pg.n2.small.1": 280, "pg.n2.medium.1": 480, "pg.n4.medium.1": 580,
    }
    
    # SLB 规格参考价格表（按量付费月费）
    SLB_PRICE_TABLE: dict[str, float] = {
        "slb.s1.small": 72, "slb.s2.small": 144, "slb.s2.medium": 216,
        "slb.s3.small": 288, "slb.s3.medium": 432, "slb.s3.large": 576,
    }

    def _estimate_price(self, spec: str, product_code: str) -> float:
        """根据规格名称估算月费。
        
        优先从参考价格表查询，无匹配则按规格解析估算。
        """
        spec_lower = spec.lower()
        
        # 优先从价格表精确匹配
        if product_code == "ecs" and spec_lower in self.ECS_PRICE_TABLE:
            return self.ECS_PRICE_TABLE[spec_lower]
        elif product_code in ("rds", "rds_mysql"):
            # RDS 尝试多种格式匹配
            for key, price in self.RDS_PRICE_TABLE.items():
                if key in spec_lower or spec_lower in key:
                    return price
        elif product_code == "slb":
            for key, price in self.SLB_PRICE_TABLE.items():
                if key in spec_lower or spec_lower in key:
                    return price
        
        # 解析规格中的核数进行估算
        size_map = {
            "small": 1,
            "medium": 2,
            "large": 2,
            "xlarge": 4,
            "2xlarge": 8,
            "4xlarge": 16,
            "8xlarge": 32,
            "16xlarge": 64,
        }
        
        cores = 2  # 默认
        for size, c in size_map.items():
            if size in spec_lower:
                cores = c
                break
        
        # 不同产品的估算基准价
        if product_code == "ecs":
            # 基于价格表推算：约 180-200 元/核/月
            return cores * 190.0
        elif product_code in ("rds", "rds_mysql"):
            # RDS 约 280 元/核/月
            return cores * 280.0
        elif product_code == "slb":
            # SLB 基础费 72 + 规格费
            return 72.0 + cores * 36.0
        elif product_code in ("redis", "r-kvstore", "kvstore"):
            # Redis 约 300 元/GB/月（参考官网价格）
            return cores * 300.0
        elif product_code in ("nat", "natgateway", "nat_gateway"):
            # NAT 网关约 216 元/月（小型）
            nat_price_map = {
                "small": 216,
                "middle": 432,
                "large": 864,
                "xlarge": 1296,
            }
            for key, price in nat_price_map.items():
                if key in spec_lower:
                    return float(price)
            return 216.0
        elif product_code in ("eip", "elasticip"):
            # EIP 按带宽估算，假设 5Mbps
            try:
                bandwidth = int(spec)
                return bandwidth * 0.8 * 24 * 30  # 约 0.8元/Mbps/小时
            except ValueError:
                return 200.0
        elif product_code in ("mse", "mse_nacos", "mse_zookeeper"):
            # MSE 注册中心估算价格（按 CPU 核数）
            # 参考官网价格: 1核 约 200-300 元/月
            mse_price_map = {
                "mse.pro.2c4g": 600,
                "mse.pro.4c8g": 1200,
                "mse.pro.8c16g": 2400,
                "mse.dev.1c2g": 200,
            }
            for key, price in mse_price_map.items():
                if key in spec_lower:
                    return float(price)
            # 默认 4 核价格
            return cores * 300.0
        elif product_code in ("disk", "ebs", "yundisk"):
            # 云盘按 GB 估算
            try:
                size_gb = int(spec)
                return size_gb * 0.1 * 24 * 30  # 约 0.1元/GB/小时（ESSD PL0）
            except ValueError:
                return 100.0
        else:
            return cores * 190.0
