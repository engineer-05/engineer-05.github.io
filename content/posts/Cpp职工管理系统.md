---
date: '2026-06-19T12:00:00+08:00'
draft: false
title: 'C++职工管理系统——基于多态的CRUD控制台应用'
categories: ['学习记录']
tags: ['C++', '面向对象', '多态', '文件流', '管理系统']
---

## 前言

职工管理系统是一个经典的管理系统练手项目——对员工信息进行**增删改查（CRUD）**，并通过文件实现**持久化存储**。市面上这类系统大多用 C 语言的链表或结构体数组实现，而这篇文章将展示如何用 C++ 的**面向对象**特性，通过多态设计一个更具扩展性的职工管理系统。

系统围绕三种角色构建：**普通员工（Employee）**、**经理（Manager）** 和 **总裁（Boss）**。三者共享统一的 `Worker` 抽象接口，但各自展示不同的信息。数据通过文本文件 `empfile.txt` 持久化，每次启动自动加载。

---

## 一、总体架构：为什么用多态？

### 需求驱动的设计选择

三种角色有共通属性（编号、姓名、职位），但又有不同的行为（`showInfo()` 显示的岗位职责不同）。这天然适合用**继承+多态**来表达：

- **共同的属性和接口**放在抽象基类 `Worker` 中
- **各自不同的行为**由子类覆写虚函数实现
- **管理代码**只需要操作 `Worker*` 指针，无需关心具体是哪种职工

如果不用多态，管理类需要为每种职工写一套独立的增删改查逻辑。三种角色就是三套代码，将来增加新角色（比如"实习生"）又要再加一套。多态让管理代码只写一次，新增角色只需新增一个子类。

### 类层次结构

```
Worker（抽象基类）
├── id         : int        职工编号
├── name       : string     职工姓名
├── deptId     : int        职位编号 (1=员工, 2=经理, 3=总裁)
├── showInfo()             纯虚函数 — 显示个人信息
└── getDeptName()          纯虚函数 — 返回职位名称

    ┌──────────┼──────────┐
    ▼          ▼          ▼
Employee    Menager     Boss
 (员工)      (经理)      (总裁)

workerManager（管理类）
├── EmpArray  : Worker**   职工指针数组
├── EmpNum    : int        职工总数
├── FileIsEmpty : bool     文件是否为空
├── Add_Emp()              添加职工
├── show_Emp()             显示所有职工
├── delete_Emp()           删除职工
├── mod_Emp()              修改职工
├── find_Emp()             查找职工
├── sort_Emp()             排序职工
├── save()                 保存到文件
├── init_Emp()             从文件初始化
└── Clean_File()           清空数据
```

`deptId` 字段既是职位编号，也在文件存储中作为角色标识——从文件读回数据时，根据这个字段判断该创建哪个子类对象。

---

## 二、抽象基类与子类设计

### Worker 基类

抽象基类定义了所有职工的共同接口，子类必须实现这两个纯虚函数：

```cpp
// worker.h
#pragma once
#include <iostream>
#include <string>
using namespace std;

class Worker
{
public:
    virtual void showInfo() = 0;      // 显示个人信息
    virtual string getDeptName() = 0; // 返回职位名称
    int id;
    string name;
    int deptId;
};
```

### 三个子类

每个子类的构造函数接收 `(id, name, deptId)` 三个参数，并覆写 `showInfo()` 展示不同的岗位职责：

```cpp
// employee.cpp — 普通员工
void Employee::showInfo()
{
    cout << "职工编号：" << this->id
         << "\t职工姓名：" << this->name
         << "\t岗位：" << this->getDeptName()
         << "\t岗位职责：完成经理的任务" << endl;
}
string Employee::getDeptName() { return "员工"; }

// menager.cpp — 经理
void Menager::showInfo()
{
    cout << "职工编号：" << this->id
         << "\t职工姓名：" << this->name
         << "\t岗位：" << this->getDeptName()
         << "\t岗位职责：完成老板的任务" << endl;
}
string Menager::getDeptName() { return "经理"; }

// boss.cpp — 总裁
void Boss::showInfo()
{
    cout << "职工编号：" << this->id
         << "\t职工姓名：" << this->name
         << "\t岗位：" << this->getDeptName()
         << "\t岗位职责：管理公司所有事物" << endl;
}
string Boss::getDeptName() { return "总裁"; }
```

子类的实现非常简洁——每个类只负责定义自己的显示内容和职位名称。核心的业务逻辑全部集中在 `workerManager` 中。

---

## 三、核心管理类 workerManager

`workerManager` 是整个系统的大脑，管理一个 `Worker**` 类型的动态数组，所有 CRUD 操作都由它提供。

### 3.1 构造函数：从文件还原数据

构造函数是系统入口的关键，它有三种路径：

1. **文件不存在** → `EmpArray = NULL`，`EmpNum = 0`
2. **文件存在但为空** → 同上
3. **文件有数据** → 调用 `get_EmpNum()` 统计人数，用 `new Worker*[num]` 开辟数组，再调 `init_Emp()` 逐行读取

```cpp
workerManager::workerManager()
{
    ifstream ifs;
    ifs.open(FILE, ios::in);

    if (!ifs.is_open()) {
        // 情况1：文件不存在
        this->EmpNum = 0;
        this->EmpArray = NULL;
        this->FileIsEmpty = true;
        return;
    }

    char ch;
    ifs >> ch;
    if (ifs.eof()) {
        // 情况2：文件为空
        this->EmpNum = 0;
        this->EmpArray = NULL;
        this->FileIsEmpty = true;
        return;
    }

    // 情况3：文件有数据，初始化
    int num = this->get_EmpNum();
    this->EmpNum = num;
    this->EmpArray = new Worker *[num];
    this->init_Emp();
}
```

### 3.2 从文件重建对象

`init_Emp()` 根据每行的 `deptId` 判断创建哪个子类——这是运行时多态的关键：

```cpp
void workerManager::init_Emp()
{
    ifstream ifs;
    ifs.open(FILE, ios::in);
    int id, did;
    string name;
    int i = 0;

    while (ifs >> id && ifs >> name && ifs >> did) {
        Worker *worker = NULL;
        switch (did) {
            case 1: worker = new Employee(id, name, did); break;
            case 2: worker = new Menager(id, name, did);  break;
            case 3: worker = new Boss(id, name, did);     break;
        }
        this->EmpArray[i++] = worker;
    }
    ifs.close();
}
```

所有子类对象通过 `Worker*` 指针存入同一个数组。后面调用 `showInfo()` 时，C++ 的虚函数机制会自动路由到正确的子类实现。

### 3.3 添加职工与动态扩容

添加职工的难点在于数组是固定大小的，每次添加都需要**重新分配更大的数组**：

```cpp
void workerManager::Add_Emp()
{
    int add_num;
    cin >> add_num;

    int newSize = this->EmpNum + add_num;
    Worker **newSpace = new Worker *[newSize];

    // 1. 搬移旧数据
    for (int i = 0; i < this->EmpNum; i++)
        newSpace[i] = this->EmpArray[i];

    // 2. 接收新数据（含职位选择循环）
    for (int i = 0; i < add_num; i++) {
        // ... 输入编号、姓名 ...
        Worker *worker = NULL;
        while (true) {
            cout << "1、普通职工  2、经理  3、总裁" << endl;
            int did;
            cin >> did;
            switch (did) {
                case 1: worker = new Employee(id, name, did); break;
                case 2: worker = new Menager(id, name, did);  break;
                case 3: worker = new Boss(id, name, did);     break;
                default: cout << "输入错误，重新输入" << endl; continue;
            }
            break;  // 成功创建，跳出循环
        }
        newSpace[this->EmpNum + i] = worker;
    }

    // 3. 释放旧数组，更新指针和计数
    delete[] this->EmpArray;
    this->EmpArray = newSpace;
    this->EmpNum = newSize;
    this->save();  // 写回文件
}
```

动态扩容三步曲：**开辟新空间 → 搬移旧数据 → 释放旧数组**。注意 `delete[]` 只释放指针数组本身，不释放指针指向的对象——那些对象已经搬到了新数组中，由析构函数最终负责释放。

### 3.4 删除职工：数据前移覆盖

删除不涉及内存重新分配，而是通过**数据前移覆盖**实现：

```cpp
void workerManager::delete_Emp()
{
    int id;
    cin >> id;
    int index = this->IsExist(id);  // 查找目标下标
    if (index == -1) {
        cout << "删除失败，不存在该员工" << endl;
        return;
    }
    // 数据前移覆盖
    for (int i = index; i + 1 < this->EmpNum; i++)
        this->EmpArray[i] = this->EmpArray[i + 1];

    this->EmpNum--;
    this->save();  // 写回文件
}
```

数组末尾多出一个无用的指针位置，但由于 `EmpNum` 已减 1，它不会被访问到。真正释放内存由析构函数在程序结束时统一处理。

### 3.5 排序：选择排序

系统支持两种排序方式：**按编号升序**和**按职位编号降序**，均使用选择排序算法。排序只交换指针，不复制对象本身——这是使用指针数组的另一个优势。

```cpp
void workerManager::sort_Emp()
{
    // 按编号升序
    for (int i = 0; i < this->EmpNum - 1; i++) {
        int min_index = i;
        for (int j = i + 1; j < this->EmpNum; j++) {
            if (this->EmpArray[j]->id < this->EmpArray[min_index]->id)
                min_index = j;
        }
        if (min_index != i) {
            Worker *worker = this->EmpArray[i];
            this->EmpArray[i] = this->EmpArray[min_index];
            this->EmpArray[min_index] = worker;
        }
    }
    this->save();
    this->show_Emp();
}
```

---

## 四、文件持久化设计

数据文件 `empfile.txt` 的格式非常简单：

```
<编号> <姓名> <职位编号>
```

例如：

```
32 孙悟空 3
8 王五 2
53 沙和尚 2
5 赖六 1
43 猪八戒 1
```

每执行一次增/删/改/排序操作后，立即调用 `save()` 将内存数据全量写回文件：

```cpp
void workerManager::save()
{
    ofstream ofs;
    ofs.open(FILE, ios::out);
    for (int i = 0; i < this->EmpNum; i++) {
        ofs << this->EmpArray[i]->id << " "
            << this->EmpArray[i]->name << " "
            << this->EmpArray[i]->deptId << endl;
    }
    ofs.close();
}
```

这是一种**简单直接但有效**的策略。对于职工管理这种小数据量场景，全量写回比增量更新实现成本低得多，也不会产生并发一致性问题。

---

## 五、总结

回顾整个项目的核心流程：

```
程序启动 → 读文件 → 还原对象数组 → 菜单交互 → 操作后写回文件 → 退出
```

项目用到的关键 C++ 技术点：

- **继承与多态**：`Worker` 抽象基类 + 三个子类，虚函数实现运行时多态
- **二级指针动态数组**：`Worker**` 管理对象指针数组，支持动态扩容
- **文件流操作**：`ifstream` / `ofstream` 实现文本文件的读写

这个项目很适合作为 C++ 面向对象的入门练习——代码量不大，但涵盖了多态、动态内存管理、文件 IO 三大核心知识点。

> 完整源代码见 GitHub 仓库：[engineer-05/------](https://github.com/engineer-05/------)
