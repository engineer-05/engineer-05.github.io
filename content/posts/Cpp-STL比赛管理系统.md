---
date: '2026-06-20T15:30:00+08:00'
draft: false
title: 'C++ STL 实战：从零构建一个比赛管理系统'
categories: ['学习记录']
tags: ['C++', 'STL', '容器', '算法', '项目实战']
---

## 前言

学完 STL 的六种容器和常用算法之后，最容易陷入的困境是：每个组件都认识，但不知道什么时候该用哪个。

这个项目就是我为了打破这种困境而写的——**用 STL 从头实现一个完整的比赛管理系统**。整个过程不依赖任何第三方库，只用 C++ 标准库中的容器和算法。

---

## 一、这个项目实现了什么？

在深入代码之前，先用一张图看清整个系统在做什么。

### 1.1 比赛流程

```
12 名选手（A~L）
  │
  ├─ 初赛
  │   shuffle 随机抽签 -> 分 2 组 x 6 人
  │   每组 10 位评委打分 -> 去最值取平均
  │   每组取前 3 名 -> 共 6 人晋级 v2
  │
  ├─ 决赛
  │   shuffle 再次抽签 -> 1 组 x 6 人
  │   同规则打分排名 -> 取前 3 名进 v3
  │
  └─ 保存
      冠亚季军信息追加写入 data.csv
```

**比赛规模是固定的**：初始 12 人（v1），初赛晋级 6 人（v2），决赛获奖 3 人（v3）。这个项目没有做成可配置的——人数、组数、晋级名额都写死在代码里。因为它的目的不是做一个"通用比赛系统"，而是把 STL 容器和算法用在一个有真实逻辑的场景里。

### 1.2 功能菜单

```
***************************************
*************  欢迎参加比赛  *************
*************  1.开始比赛    *************
*************  2.查看往届记录  *************
*************  3.清空记录    *************
*************  0.退出比赛    *************
***************************************
```

四个选项对应四个核心功能：

| 选项 | 功能 | 背后做的事情 |
|:---|:---|:---|
| 1. 开始比赛 | 自动跑完初赛→决赛→保存全流程 | draw() → contest()×2 → save() |
| 2. 查看往届记录 | 读取 data.csv 展示历史冠亚季军 | load()，手动解析 CSV |
| 3. 清空记录 | 删除历史数据并重置选手 | clearRecord()，trunc 模式 + 重新初始化 |
| 0. 退出 | 结束程序 | exit(0) |

### 1.3 数据如何流转？

程序运行时维护着三组容器，数据在它们之间按规则流动：

```
v1 (vector, 12人)
  |   初赛晋级, 12人分2组, 每组取前3
  |
  v
v2 (vector, 6人)
  |   决赛, 6人取前3
  |
  v
v3 (vector, 3人)  ----追加写入----> data.csv (往届记录)

m_player (map)
  编号 -> {姓名, 分数}
  v1、v2、v3 都通过编号从这里查找选手信息
```

搞清楚了"做什么"，接下来逐步拆解"怎么做"——以及每一步背后容器选择的理由。

---

## 二、容器选型：每个需求找到最合适的 STL 组件

这是整个项目最重要的设计环节。面对一个需求，选择什么容器，直接决定了后续代码的复杂度和可维护性。

### 2.1 为什么用 `vector` 存选手编号？

三组选手编号——v1（12 人）、v2（6 人）、v3（3 人）——都用 `vector<int>`。

选择 `vector` 的理由：

1. **需要随机打乱**——`std::shuffle` 要求随机访问迭代器，`vector` 完美支持，而 `list` 不行
2. **大小已知且固定**——12 人、6 人、3 人，全程不需要在中间插入删除，`vector` 的尾部操作效率最高
3. **需要遍历**——`vector` 的内存连续性带来极好的缓存命中率

```cpp
vector<int> v1;  // 初始 12 名选手编号，固定
vector<int> v2;  // 初赛晋级 6 人，固定
vector<int> v3;  // 决赛获奖 3 人，固定
```

> **规模写死**：v1 始终 12 人（对应 `"ABCDEFGHIJKL"` 12 个字母），v2 始终 6 人（12 人分 2 组 × 每组取 3），v3 始终 3 人（6 人分 1 组 × 取前 3）。这些数字是硬编码的——练手项目的侧重点在 STL 用法，不在可配置性。

### 2.2 为什么用 `map` 存选手信息？

选手有两个属性——编号（`int`）和信息（`Player`，包含姓名和分数）。这是一个典型的 **键值映射** 场景：

```cpp
map<int, Player> m_player;  // 编号 → 选手信息
```

选择 `map` 而非 `unordered_map` 的原因：虽然 `map` 的查找是 O(log n)，比 `unordered_map` 的 O(1) 慢，但本项目只有 12 个选手，log₂12 ≈ 3.6 次比较和哈希计算的开销几乎没区别。`map` 的有序性在按编号顺序输出时更方便。

### 2.3 为什么用 `multimap` 而不是 `map` 做排名？

这是整个项目中最关键的一个选择。

每 6 人一组比赛结束后，需要按分数从高到低排列名次。分数是 key，选手编号是 value。用 `map<double, int>` 看似合理，但它有一个致命问题：

> **`map` 不允许重复的 key。如果两个选手得分相同，后插入的会直接覆盖前面的。**

在一组 6 人中，两个选手打出完全相同分数的概率并不低（尤其当分数只保留有限小数时）。`multimap` 允许重复 key，完美解决了这个问题。

```cpp
// greater<double> 指定降序排列——分数高的在前面
multimap<double, int, greater<double>> groupScore;

// 插入（允许同分）
groupScore.insert(make_pair(avg, playerId));
```

### 2.4 为什么用 `deque` 存取评委分？

每个选手由 10 位评委打分，需要去掉一个最高分和一个最低分后取平均。

`deque<double>` 是双端队列，**头尾删除都是 O(1)**：

```cpp
deque<double> d;
for (int i = 0; i < 10; i++) {
    double score = (rand() % 201 + 800) / 10.f;  // 80.0 ~ 100.0
    d.push_back(score);
}
sort(d.begin(), d.end(), greater<double>());  // 降序排列
d.pop_front();   // 去掉最高分（头部）
d.pop_back();    // 去掉最低分（尾部）
double sum = accumulate(d.begin(), d.end(), 0.0);
double avg = sum / d.size();  // 8 个有效分的平均
```

如果换成 `vector`，头部删除需要移动所有元素（O(n)）；换成 `list`，则无法用 `std::sort`（它要求随机访问迭代器）。`deque` 恰好两头都占了。

### 2.5 容器选型总结

| 需求 | 选择的容器 | 核心理由 |
|:---|:---|:---|
| 存选手编号（需 shuffle） | `vector<int>` | 随机访问迭代器 + 连续内存 |
| 编号→选手映射 | `map<int, Player>` | 键值查找，数据量小无需哈希 |
| 分组排名（允许同分） | `multimap<double, int, greater<>>` | 允许重复 key + 自动排序 |
| 评委打分（去最值） | `deque<double>` | 头尾删除 O(1) + 支持 sort |
| 历史记录存储 | `map<int, vector<string>>` | 按届数索引，一行多字段 |

---

## 三、选手初始化：批量创建与编号管理

```cpp
void contestManager::create_player() {
    string nameSeed = "ABCDEFGHIJKL";
    for (int i = 0; i < nameSeed.size(); i++) {
        string name = "选手";
        name += nameSeed[i];           // 选手A, 选手B, ..., 选手L

        Player player;
        player.name = name;
        player.score = 0;

        v1.push_back(i + 1);           // 编号 1~12 存入 v1
        m_player.insert(make_pair(i + 1, player));  // 编号→选手信息
    }
}
```

设计要点：
- **名字生成**：用一个 12 字母的种子字符串 `"ABCDEFGHIJKL"`，循环拼接 `"选手" + 字母`，生成选手 A 到选手 L
- **编号从 1 开始**：与数组下标从 0 开始的习惯不同，这里编号从 1 开始更符合人类的直觉（"第 1 号选手"）
- **两处同步维护**：编号同时存入 `v1`（用于抽签和遍历）和 `m_player`（用于通过编号查信息），两套结构各司其职

---

## 四、抽签：`std::shuffle` 的正确用法

```cpp
void contestManager::draw() {
    cout << "第 <<" << index << ">> 轮比赛选手正在抽签" << endl;
    cout << "抽签后的顺序如下：" << endl;

    if (index == 1) {
        // 第一轮：打乱 v1
        std::random_device rd;
        std::mt19937 g(rd());
        std::shuffle(v1.begin(), v1.end(), g);
        for (auto it = v1.begin(); it != v1.end(); it++)
            cout << *it << " ";
    } else {
        // 第二轮：打乱 v2（晋级者）
        std::random_device rd;
        std::mt19937 g(rd());
        std::shuffle(v2.begin(), v2.end(), g);
        for (auto it = v2.begin(); it != v2.end(); it++)
            cout << *it << " ";
    }
    cout << endl;
}
```

### 为什么用 `std::shuffle` 而不是 `std::random_shuffle`？

`std::random_shuffle` 在 C++14 中已被标记为弃用，在 C++17 中被彻底移除。原因是它内部依赖 `rand()`，随机性不够好。`std::shuffle` 需要显式传入一个随机数引擎（这里用了 `std::mt19937`），随机质量更高，行为也更可控。

**`std::mt19937` + `std::random_device` 的组合**是 C++11 之后推荐的随机数方案：`random_device` 提供真随机种子，`mt19937`（梅森旋转算法）生成高质量伪随机序列。

---

## 五、比赛核心：打分 → 排序 → 晋级

这是整个系统最复杂的方法 `contest()`，大约 50 行代码，但逻辑密度很高。

### 5.1 数据来源的选择

```cpp
vector<int> v_src;
if (index == 1)
    v_src = v1;   // 第一轮：从 12 人池中取
else
    v_src = v2;   // 第二轮：从 6 人晋级池中取
```

用一个临时 `vector` 引用（实际上是拷贝）统一后续的遍历逻辑，避免两套几乎相同的代码。

### 5.2 打分与排序

每位选手由 10 个评委打分，分数范围 80.0 ~ 100.0：

```cpp
double score = (rand() % 201 + 800) / 10.f;
// rand() % 201    → 0 ~ 200
// + 800           → 800 ~ 1000
// / 10.f          → 80.0 ~ 100.0（保留一位小数）
```

去最值、求和、取平均后，同时做了两件事：
1. 把平均分存回选手的 `m_player` map（`m_player[id].score = avg`）
2. 把（分数, 编号）插入 `multimap`（自动降序排列）

### 5.3 每 6 人取前 3 的逻辑

```cpp
int num = 0;  // 计数器
for (auto it = v_src.begin(); it != v_src.end(); it++) {
    num++;
    // ... 打分、计算平均分、插入 multimap ...

    if (num % 6 == 0) {  // 每满 6 人
        // 打印本组排名（multimap 已自动排好序）
        for (auto it = groupScore.begin(); it != groupScore.end(); it++)
            cout << "编号：" << it->second << "\t姓名：" << ... << "\t成绩：" << it->first;

        // 取前 3 名晋级
        int count = 0;
        for (auto it = groupScore.begin();
             it != groupScore.end() && count < 3;
             it++, count++) {
            if (index == 1)
                v2.push_back(it->second);  // 晋级到 v2
            else
                v3.push_back(it->second);  // 晋级到 v3（获奖）
        }
        groupScore.clear();  // 清空，准备下一组
    }
}
```

**为什么用取模运算（`num % 6 == 0`）？** 第一轮有 12 人，分 2 组，每组 6 人。当计数器是 6 的倍数时，说明刚好打完一组，可以输出结果并取前 3 名晋级。`clear()` 清空临时 multimap，确保下一组的数据不受干扰。

**为什么晋级逻辑用 `count < 3` 而不是取前 3 个迭代器？** 因为 multimap 的迭代器就是按 key（分数）排序的，`begin()` 就是最高分，依次往后就是第 2、第 3 名。用计数器限制循环次数，比直接操作迭代器更直观。

第二轮（决赛）只有 6 人，`num % 6 == 0` 只会触发一次，6 人中取前 3 进入 v3，即为冠亚季军。

---

## 六、数据持久化：CSV 的写入与解析

### 6.1 保存：追加写入 CSV

```cpp
void contestManager::save() {
    ofstream ofs;
    ofs.open("data.csv", ios::out | ios::app);  // append 模式
    for (auto it = v3.begin(); it != v3.end(); it++) {
        ofs << *it << ","
            << m_player[*it].name << ","
            << m_player[*it].score << ",";
    }
    ofs << endl;   // 一行一条完整记录（冠亚季军共 9 个字段）
    ofs.close();
}
```

每行 9 个逗号分隔的字段：`冠军编号,姓名,分数,亚军编号,姓名,分数,季军编号,姓名,分数`。

`ios::app` 保证每次比赛结果追加到文件末尾，不会覆盖往届记录。

### 6.2 读取：手动解析 CSV

```cpp
void contestManager::load() {
    ifstream ifs("data.csv", ios::in);

    // 文件不存在
    if (!ifs.is_open()) {
        file_is_empty = true;
        cout << "文件不存在或为空" << endl;
        return;
    }

    // 文件存在但内容为空
    if (ifs.peek() == EOF) {
        file_is_empty = true;
        cout << "暂无往届记录" << endl;
        return;
    }

    // 逐行读取，用逗号定位分割
    string data;
    int index = 1;
    while (ifs >> data) {
        vector<string> v;
        int pos = -1, start = 0;

        while (true) {
            pos = data.find(",", start);    // 找下一个逗号
            if (pos == -1) break;
            string temp = data.substr(start, pos - start);  // 截取字段
            v.push_back(temp);
            start = pos + 1;
        }

        m_record.insert(make_pair(index, v));  // 第 index 届 → 字段列表
        index++;
    }
}
```

有几个值得注意的细节：

**`ifs.peek() == EOF` 判断空文件**——不能只判断 `is_open()`。文件可能存在但内容为空（比如被 `ios::trunc` 清空后），这种情况下用 `>>` 读取什么都不会发生，但程序应该给用户明确的提示。

**手动解析而不使用第三方 CSV 库**——因为这个 CSV 格式极其简单（没有转义、没有引号包裹、没有逗号内嵌），手写解析器只需 10 行代码，引入一个库反而增加复杂度。

**`m_record` 的类型是 `map<int, vector<string>>`**——key 是届数（1, 2, 3...），value 是该届 9 个字段的字符串列表。读取后按固定索引取值：`v[0]` 冠军编号、`v[1]` 冠军姓名、`v[2]` 冠军分数……依此类推。

### 6.3 清空记录

```cpp
void contestManager::clearRecord() {
    // ios::trunc —— 打开时清空文件内容
    ofstream ofs("data.csv", ios::trunc);
    ofs.close();

    contest_Init();     // 重置所有容器
    create_player();    // 重新创建 12 名选手
}
```

清空操作做了两件事：物理删除文件内容（`trunc` 模式）和重置内存状态。如果只清空文件而不重置容器，后续操作会出现数据不一致。

---

## 七、程序入口：菜单驱动的交互设计

```cpp
int main() {
    contestManager cm;  // 构造时自动初始化 + 创建选手

    while (true) {
        cm.show_Menu();
        int choice;
        cin >> choice;

        switch (choice) {
        case 1: cm.startcontest();  break;   // 开始比赛
        case 2: cm.load();          break;   // 查看往届记录
        case 3: cm.clearRecord();   break;   // 清空记录
        case 0: cm.exit_System();   break;   // 退出
        default: cout << "输入有误，请重新输入" << endl;
        }
    }
}
```

设计要点：
- **构造函数中完成初始化**——`contestManager` 对象创建时自动调用 `contest_Init()` 和 `create_player()`，使用者无需关心初始化细节
- **循环菜单**——`while(true)` 保证用户可以反复操作，直到选择退出
- **`startcontest()` 一气呵成**——一次调用完成"初赛抽签→初赛→显示结果→决赛抽签→决赛→显示结果→保存"的全流程，用户体验流畅

---

## 八、总结

回顾这个项目，核心流程可以概括为：

```
初始化容器 → 创建选手 → 抽签(shuffle) → 打分(deque + accumulate)
→ 排名(multimap) → 分组取前三(模运算) → 晋级(v2/v3)
→ 重置 → 下一轮 → 保存(CSV追加) → 可查询历史
```

这个项目虽然只有约 300 行代码，但它把 STL 中最常用的几种容器和算法串在了一起——每个组件都在解决一个具体的问题，没有一个是"为了用而用"的。这也是学完 STL 之后最好的巩固方式：**用实际需求驱动容器选择，而不是反过来**。

> 完整源代码见 GitHub 仓库：[engineer-05/Match-Management-Tool](https://github.com/engineer-05/Match-Management-Tool)
