# 读取上次保存的数字
try:
    with open("num.txt", "r", encoding="utf-8") as f:
       count = int(f.read())
except:
    #文件不存在就初始化为0
    count = 0

# 运行一次 +1
#count=0
count += 1
print(f"本次运行次数：{count}")

# 保存新数值到文件
with open("num.txt", "w", encoding="utf-8") as f :          
    f.write(str(count))

# 你原来的循环代码
i = 0
while i < 1:
    print(i)
    i = i + 1

weight = 80
weight += count  # 体重也跟着运行次数累加
print(weight, id(weight), type(weight))