---
date: '2026-06-20T15:30:00+08:00'
draft: false
title: 'C++ STL 实战：从零构建一个比赛管理系统'
categories: ['学习记录']
tags: ['C++', 'STL', '容器', '算法', '项目实战']
---

## 前言

学完 STL 的六种容器和常用算法之后，最容易陷入的困境是：每个组件都认识，但不知道什么时候该用哪个。

这个项目就是我为了打破这种困境而写的——**用 STL 从头实现一个完整的比赛管理系统**，涵盖抽签、打分、排名、晋级、数据保存和读取的全流程。整个过程不依赖任何第三方库，只用了 C++ 标准库中的容器和算法。

项目虽小，但在设计过程中，每一个容器的选择都是有原因的。

---

## 一、容器选型：每个需求找到最合适的 STL 组件

这是整个项目最重要的设计环节。面对一个需求，选择什么容器，直接决定了后续代码的复杂度和可维护性。

### 1.1 为什么用 `vector` 存选手编号？

比赛中有三组选手编号需要管理：

- **v1**：初始 12 名选手的编号（1~12）
- **v2**：第一轮晋级者的编号（最多 6 人）
- **v3**：决赛获奖者的编号（3 人）

选择 `vector<int>` 的理由很简单：

1. **需要随机打乱**——`std::shuffle` 要求随机访问迭代器，`vector` 完美支持，而 `list` 不行
2. **大小已知且变化不大**——不需要频繁在中间插入删除，`vector` 的尾部操作效率最高
3. **需要遍历**——`vector` 的内存连续性带来极好的缓存命中率

```cpp
vector<int> v1;  // 初始 12 名选手编号
vector<int> v2;  // 第一轮晋级者
vector<int> v3;  // 决赛获奖者（冠亚季军）
```

### 1.2 为什么用 `map` 存选手信息？

选手有两个属性——编号（`int`）和信息（`Player`，包含姓名和分数）。这是一个典型的 **键值映射** 场景：

```cpp
map<int, Player> m_player;  // 编号 → 选手信息
```

选择 `map` 而非 `unordered_map` 的原因：虽然 `map` 的查找是 O(log n)，比 `unordered_map` 的 O(1) 慢，但本项目只有 12 个选手，log₂12 ≈ 3.6 次比较和哈希计算的开销几乎没区别。`map` 的有序性在按编号顺序输出时更方便。

### 1.3 为什么用 `multimap` 而不是 `map` 做排名？

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

### 1.4 为什么用 `deque` 存取评委分？

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

### 1.5 容器选型总结

| 需求 | 选择的容器 | 核心理由 |
|:---|:---|:---|
| 存选手编号（需 shuffle） | `vector<int>` | 随机访问迭代器 + 连续内存 |
| 编号→选手映射 | `map<int, Player>` | 键值查找，数据量小无需哈希 |
| 分组排名（允许同分） | `multimap<double, int, greater<>>` | 允许重复 key + 自动排序 |
| 评委打分（去最值） | `deque<double>` | 头尾删除 O(1) + 支持 sort |
| 历史记录存储 | `map<int, vector<string>>` | 按届数索引，一行多字段 |

---

## 二、选手初始化：批量创建与编号管理

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

## 三、抽签：`std::shuffle` 的正确用法

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

## 四、比赛核心：打分 → 排序 → 晋级

这是整个系统最复杂的方法 `contest()`，大约 50 行代码，但逻辑密度很高。

### 4.1 数据来源的选择

```cpp
vector<int> v_src;
if (index == 1)
    v_src = v1;   // 第一轮：从 12 人池中取
else
    v_src = v2;   // 第二轮：从 6 人晋级池中取
```

用一个临时 `vector` 引用（实际上是拷贝）统一后续的遍历逻辑，避免两套几乎相同的代码。

### 4.2 打分与排序

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

### 4.3 每 6 人取前 3 的逻辑

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

## 五、数据持久化：CSV 的写入与解析

### 5.1 保存：追加写入 CSV

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

### 5.2 读取：手动解析 CSV

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

### 5.3 清空记录

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

## 六、程序入口：菜单驱动的交互设计

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

## 七、踩过的坑与改进建议

### 7.1 随机数方案不一致

`draw()` 中用了 C++11 的 `std::mt19937`，但 `contest()` 中打分仍用 C 风格的 `rand()`。两者各有一套种子机制，混用容易造成困惑。

**建议**：统一用 `<random>` 库。将打分部分改为：

```cpp
std::uniform_real_distribution<double> dist(80.0, 100.0);
double score = dist(g);  // g 是 mt19937 引擎
```

### 7.2 `using namespace std` 写在头文件中

`Player.h` 和 `contestManager.h` 都在全局作用域写了 `using namespace std;`。头文件被其他文件 `#include` 时会污染命名空间，这在大型项目中会造成名字冲突。

**建议**：头文件中使用 `std::` 前缀，将 `using namespace std;` 移到 `.cpp` 实现文件中。

### 7.3 每次比赛都重置选手

`startcontest()` 结束后立即调用 `contest_Init()` + `create_player()`，这意味着**每次比完赛选手状态就丢失了**。如果后续想扩展"多轮积分赛""选手历史战绩追踪"等功能，这种设计就需要大改。

### 7.4 源码文件编码

源代码中的中文注释使用了 GBK 编码，在非中文 Windows 系统或 Linux/macOS 上显示为乱码。建议统一转为 **UTF-8**。

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
