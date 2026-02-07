#!/usr/bin/env python3
import pandas as pd
import sys

if len(sys.argv) < 2:
    print("Usage: python3 read_excel.py <excel_file_path>")
    sys.exit(1)

file_path = sys.argv[1]

# 读取Excel文件
xl = pd.ExcelFile(file_path)
print('=== 工作表列表 ===')
print(xl.sheet_names)
print()

# 读取每个工作表
for sheet_name in xl.sheet_names:
    print(f'=== 工作表: {sheet_name} ===')
    df = pd.read_excel(file_path, sheet_name=sheet_name)
    # 处理NaN值，使其显示为空字符串
    df = df.fillna('')
    print(df.to_string(index=False))
    print()
