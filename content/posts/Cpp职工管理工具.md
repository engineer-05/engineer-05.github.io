---
date: '2026-06-19T12:00:00+08:00'
draft: false
title: 'C++职工管理工具——多态、二级指针与文件持久化'
categories: ['学习记录']
tags: ['C++', '面向对象', '多态', '文件流', '职工管理']
aliases:
  - /posts/cpp职工管理系统/
---

## 前言

职工管理工具是一个经典的控制台 CRUD 练手项目——对员工信息进行**增删改查**，并通过文件实现**持久化存储**。和常见的 C 语言版本不同，这个项目用 C++ **面向对象多态**来设计，核心不到 500 行代码，却把**继承体系、二级指针数组、文件持久化、内存管理**四个关键点串在了一起。

系统围绕三种角色构建：**普通员工（Employee）**、**经理（Manager）** 和 **总裁（Boss）**。三者共享统一的 `Worker` 抽象接口，但各自展示不同的信息。数据通过文本文件 `empfile.txt` 持久化，每次启动自动加载。下面就以四条关键点和两个实际难点为主线，拆解整个项目的设计思路。

---

## 关键点一：基类与派生类

### 为什么用多态？

三种角色有共通属性（编号、姓名、职位），但 `showInfo()` 显示的岗位职责各不相同。如果不用多态，管理类需要为每种职工写一套独立的增删改查逻辑——三种角色三套代码。用**继承+多态**，管理代码只写一次，以后加"实习生"角色只需新增一个派生类。

### 类层次结构

**Worker 抽象基类** — 定义统一接口：

- `id` : int — 职工编号
- `name` : string — 职工姓名
- `deptId` : int — 职位编号（1=员工, 2=经理, 3=总裁）
- `showInfo()` : 纯虚函数 — 显示个人信息
- `getDeptName()` : 纯虚函数 — 返回职位名称

**三个派生类**（均继承 Worker）：

- `Employee` — 员工，职责：完成经理的任务
- `Menager` — 经理，职责：完成老板的任务
- `Boss` — 总裁，职责：管理公司所有事物

**workerManager 管理类** — 核心业务逻辑：

| 成员 | 类型/返回值 | 说明 |
|:---|:---|:---|
| EmpArray | `Worker**` | 职工指针数组 |
| EmpNum | `int` | 职工总数 |
| FileIsEnpty | `bool` | 文件状态标志位 |
| Add_Emp() | `void` | 添加职工 |
| show_Emp() | `void` | 显示所有职工 |
| delete_Emp() | `void` | 删除职工 |
| mod_Emp() | `void` | 修改职工 |
| find_Emp() | `void` | 查找职工 |
| sort_Emp() | `void` | 排序职工 |
| save() | `void` | 保存到文件 |
| init_Emp() | `void` | 从文件初始化 |
| Clean_File() | `void` | 清空数据 |

### 代码实现

抽象基类定义统一接口：

```cpp
class Worker
{
public:
    virtual void showInfo() = 0;      // 纯虚函数，子类各自实现
    virtual string getDeptName() = 0;

    int id;
    string name;
    int deptId;    // 1=员工  2=经理  3=总裁
};
```

三个派生类只做一件事：定义"我是谁"和"我干什么"：

```cpp
// Employee — 员工
string Employee::getDeptName() { return "员工"; }
void Employee::showInfo() {
    cout << "职工编号：" << id
         << "\t姓名：" << name
         << "\t岗位：" << getDeptName()
         << "\t职责：完成经理的任务" << endl;
}

// Menager — 经理
string Menager::getDeptName() { return "经理"; }
// showInfo() 显示 "职责：完成老板的任务"

// Boss — 总裁
string Boss::getDeptName() { return "总裁"; }
// showInfo() 显示 "职责：管理公司所有事物"
```

子类代码极其简短，业务逻辑全部集中在管理类中。`deptId` 字段既是职位编号，也在文件存储中作为角色标识——从文件读回数据时，根据这个字段决定创建哪个子类对象。

---

## 关键点二：基类二级指针 + 动态多态

这是整个项目最核心的设计决策。职工数组声明为：

```cpp
Worker **EmpArray;  // 基类的二级指针
```

**为什么是二级指针？**

- `Worker*` 是基类一级指针，可以指向任意派生类对象
- `new Worker*[n]` 分配一个指针数组，每个槽存一个 `Worker*`
- 数组首地址的类型就是 `Worker**`

**为什么不用 `vector<Worker>`？** `vector` 会发生对象切片——派生类对象被截断成基类，多态失效。用指针数组，每个元素只是 8 字节的地址，实际对象完整地待在堆上。

### 多态是怎么发生的？

```cpp
// 创建阶段：基类指针绑定派生类对象
Worker *worker = NULL;
switch (deptId) {
    case 1: worker = new Employee(id, name, deptId); break;
    case 2: worker = new Menager(id, name, deptId);  break;
    case 3: worker = new Boss(id, name, deptId);     break;
}
EmpArray[i] = worker;   // 统一存入基类指针数组

// 调用阶段：同一个调用，三种不同行为
EmpArray[i]->showInfo();
// 实际指向 Employee → Employee::showInfo()  → "职责：完成经理的任务"
// 实际指向 Menager  → Menager::showInfo()   → "职责：完成老板的任务"
// 实际指向 Boss    → Boss::showInfo()       → "职责：管理公司所有事物"
```

虚函数表在运行时根据对象实际类型自动分发，调用方不需要知道具体是哪个子类。

### 添加职工：动态扩容

添加职工时数组长度不够用，需要扩容。思路是**开辟新空间 → 搬移旧指针 → 存入新数据 → 释放旧数组**：

```cpp
void workerManager::Add_Emp()
{
    int newSize = this->EmpNum + add_num;
    Worker **newSpace = new Worker *[newSize];   // 1. 开更大的数组

    for (int i = 0; i < this->EmpNum; i++)       // 2. 搬移旧指针
        newSpace[i] = this->EmpArray[i];

    for (int i = 0; i < add_num; i++) {
        // 输入编号和姓名...
        Worker *worker = NULL;
        while (true) {
            // 选择职位 1/2/3
            switch (did) {
                case 1: worker = new Employee(id, name, did); break;
                case 2: worker = new Menager(id, name, did);  break;
                case 3: worker = new Boss(id, name, did);     break;
                default: continue;  // 输错重来
            }
            break;
        }
        newSpace[this->EmpNum + i] = worker;    // 3. 存入尾部
    }

    delete[] this->EmpArray;    // 4. 释放旧指针数组
    this->EmpArray = newSpace;  // 5. 指向新数组
    this->EmpNum = newSize;
    this->save();
}
```

注意 `delete[]` 只释放指针数组本身，对象指针已经搬到了 `newSpace`，由析构函数统一负责回收。

### 删除职工：数据前移覆盖

删除不重新分配内存，而是**前移覆盖**目标位置：

```cpp
void workerManager::delete_Emp()
{
    int index = this->IsExist(id);  // 查找目标下标
    // 数据前移覆盖
    for (int i = index; i + 1 < this->EmpNum; i++)
        this->EmpArray[i] = this->EmpArray[i + 1];

    this->EmpNum--;
    this->save();  // 写回文件
}
```

### 排序：只交换指针

系统支持按编号升序和按职位降序两种排序，使用选择排序算法。排序只交换指针，不复制对象本身——这是指针数组的另一个优势：

```cpp
if (min_index != i) {
    Worker *worker = this->EmpArray[i];
    this->EmpArray[i] = this->EmpArray[min_index];
    this->EmpArray[min_index] = worker;      // 只交换指针，对象纹丝不动
}
```

---

## 关键点三：构造函数的三段式初始化

程序启动时，构造函数负责从 `empfile.txt` 把数据还原成对象。它分三种情况处理：

```cpp
workerManager::workerManager()
{
    ifstream ifs;
    ifs.open(FILE, ios::in);

    // 情况①：文件不存在
    if (!ifs.is_open()) {
        this->EmpNum = 0;
        this->EmpArray = NULL;
        this->FileIsEnpty = true;       // 标记位：无数据
        return;
    }

    // 情况②：文件存在但内容为空
    char ch;
    ifs >> ch;
    if (ifs.eof()) {
        this->EmpNum = 0;
        this->EmpArray = NULL;
        this->FileIsEnpty = true;       // 标记位：无数据
        return;
    }

    // 情况③：文件有数据 → 统计人数 → 开辟空间 → 创建对象
    this->FileIsEnpty = false;
    this->EmpNum = this->get_EmpNum();                // 统计行数
    this->EmpArray = new Worker *[this->EmpNum];     // 开辟指针数组
    this->init_Emp();                                 // 逐行创建对象
}
```

其中 `init_Emp()` 是运行时多态的关键入口——根据每行的 `deptId` 字段（1/2/3）判断角色类型，`new` 出对应的子类对象，统一用 `Worker*` 存入数组：

```cpp
void workerManager::init_Emp()
{
    int id, did;
    string name;
    int i = 0;

    while (ifs >> id >> name >> did) {
        Worker *worker = NULL;
        switch (did) {
            case 1: worker = new Employee(id, name, did); break;
            case 2: worker = new Menager(id, name, did);  break;
            case 3: worker = new Boss(id, name, did);     break;
        }
        this->EmpArray[i++] = worker;
    }
}
```

完整链路：`读文件 → 统计人数 → new 数组 → 逐行 new 对象 → 存入数组`。程序退出时 `save()` 全量回写，下次启动自动恢复。

---

## 关键点四：析构函数的两层释放

`Worker**` 涉及两次 `new`：`new Worker*[n]` 创建指针数组，`new Employee/Menager/Boss` 创建每个对象。释放必须**从内到外**，顺序不能反：

```cpp
workerManager::~workerManager()
{
    if (this->EmpArray != NULL)
    {
        // 第一层：逐个释放每个堆上的职工对象
        for (int i = 0; i < this->EmpNum; i++)
        {
            delete this->EmpArray[i];
            this->EmpArray[i] = NULL;
        }

        // 第二层：释放指针数组本身
        delete[] this->EmpArray;
        this->EmpArray = NULL;
    }
}
```

如果先 `delete[]` 数组，指针全部悬空，对象再也找不回来——内存泄漏。`Clean_File()` 清空功能里也是同样的两层释放逻辑，外加用 `ios::trunc` 打开文件实现文件内容清空。

---

## 难点一：如何实现数据持久化？

**问题**：程序一关，内存里所有职工对象消失，增删改全部白费。

**方案**：每次写操作（增/删/改/排序）后立即调用 `save()`，全量覆写文件：

```cpp
void workerManager::save()
{
    ofstream ofs(FILE, ios::out);   // 覆盖模式
    for (int i = 0; i < this->EmpNum; i++)
        ofs << EmpArray[i]->id << " "
            << EmpArray[i]->name << " "
            << EmpArray[i]->deptId << endl;
    ofs.close();
}
```

文件格式极简，空格分隔的三个字段：

```
1 唐僧 3
2 孙悟空 2
3 白龙马 1
4 猪八戒 1
5 沙和尚 1
```

`1`=员工、`2`=经理、`3`=总裁。全量写回简单可靠，小数据量下完全够用，整个流程形成闭环：**启动 → 读文件 → 还原对象 → 菜单操作 → save() 回写 → 退出 → 下次启动自动恢复**。

---

## 难点二：文件状态标志位

**问题**：显示、删除、修改、查找、排序、清空——六个函数都要先判断"有没有数据"。每次都开文件检查既慢又冗余。

**方案**：在构造函数里一次性判断，存入 `FileIsEnpty` 标志位，后面所有函数只查这个 bool：

| 场景 | FileIsEnpty |
|:---|:---|
| 文件不存在 | `true` |
| 文件存在但为空 | `true` |
| 文件有数据 | `false` |
| 新增职工后 | 置 `false` |
| 清空后 | 置 `true` |

每个操作函数开头统一判断，例如：

```cpp
void workerManager::show_Emp()
{
    if (this->FileIsEnpty) {
        cout << "文件不存在或者文件为空" << endl;
        return;
    }
    for (int i = 0; i < this->EmpNum; i++)
        this->EmpArray[i]->showInfo();  // 多态调用
}
```

状态判断从每次 I/O 变成了 O(1) 的布尔检查，代码清晰简洁。

---

## 总结

回顾整个项目的核心流程：**程序启动 → 构造函数读文件还原对象 → 菜单交互 → 操作回写文件 → 析构释放内存 → 退出**。

四个关键点串起 C++ 面向对象的核心实践：

1. **抽象基类 + 派生**：定义统一接口，子类各行其是
2. **基类二级指针数组**：`Worker**` 承载多态，扩容搬指针不动对象
3. **构造函数三段式**：文件不存在 / 为空 / 有数据，三种情况一次性处理
4. **两层析构**：先释放对象再释放数组，顺序不可颠倒

两个难点——**文件持久化**和**状态标志位**——让程序从"一次性运行"变成了一个真正可用的管理工具，每次启动自动恢复上一次的数据。

> 完整源代码见 GitHub 仓库：[engineer-05/Employee-Management-Tool](https://github.com/engineer-05/Employee-Management-Tool)
