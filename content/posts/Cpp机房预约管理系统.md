---
date: '2026-06-22T16:40:00+08:00'
draft: false
title: 'C++ 实现机房预约管理系统'
categories: ['学习记录']
tags: ['C++', '面向对象', '文件操作', 'STL', '智能指针']
---

## 前言

机房预约系统是一个经典的 C++ 课程设计项目——学生可以申请预约机房，教师负责审核，管理员统一管理账号和机房信息。麻雀虽小，五脏俱全，覆盖了**面向对象编程**中继承、多态、文件流操作、STL 容器、智能指针等核心知识点。

项目完全基于控制台运行，数据通过文本文件持久化，没有第三方依赖。

---

## 一、系统架构设计

### 三种角色，一套继承体系

系统有三种用户角色——学生、教师、管理员。它们的共性是都有用户名、密码，都需要一个操作菜单。于是抽象出**基类 `user`**：

```cpp
class user
{
public:
    virtual void oper_menu() = 0;  // 纯虚函数，各角色自己实现菜单
    string name;                    // 用户名
    string psaaword;                // 密码
};
```

`oper_menu()` 定义为纯虚函数，让 `user` 成为抽象类——不能直接实例化，只能通过子类对象来使用。三个派生类各自重写菜单：

```
        user (抽象基类)
          ├── student    → 申请预约、查看/取消预约
          ├── teacher    → 查看预约、审核预约
          └── manager    → 添加/查看账号、查看机房、清空预约
```

**为什么用继承而不是三个独立的类？** 因为登录后程序需要用一个统一的指针来操作不同角色——如果用三个独立的类，登录函数需要写三份几乎一样的代码。继承 + 多态让 `login()` 函数只需要操作 `user *`，具体调谁的 `oper_menu()` 由运行时决定。

### 为什么用文件而不是数据库？

这个项目定位是 C++ 入门练习，文件操作比数据库更直接——`ifstream` / `ofstream` 是标准库的一部分，不需要额外安装任何东西。而且 `.txt` 文件可以直接用文本编辑器打开查看，调试起来方便。

---

## 二、登录模块：统一入口，角色分发

`login()` 函数是所有角色的统一入口。它的逻辑是：

1. 根据传入的 `type`（1=学生，2=教师，3=管理员）打开对应的账号文件
2. 让用户输入编号、用户名、密码
3. 逐行读取文件，比对账号信息
4. 匹配成功后，用 `new` 创建对应的子类对象，进入子菜单

```cpp
void login(string file_name, int type)
{
    unique_ptr<user> person;       // 用智能指针管理对象生命周期
    // ... 打开文件、读取输入 ...

    if (type == 1)                 // 学生
    {
        // 逐行比对 student.txt 中的数据
        while (ifs >> fid && ifs >> fname && ifs >> fpwd)
        {
            if (fid == id && fname == name && fpwd == password)
            {
                person = make_unique<student>(id, name, password);
                student_menu(person);
                return;
            }
        }
    }
    // type == 2 和 type == 3 同理 ...
}
```

注意这里用了**智能指针 `unique_ptr`** 而非裸 `new`/`delete`——这是项目后期做的改进，后面会专门讲为什么。

---

## 三、学生模块：预约的完整生命周期

学生是整个业务流程的起点，有四个操作：申请预约、查看我的预约、查看所有预约、取消预约。

### 申请预约

申请时需要选择三个信息：**日期**（周一至周五）、**时间段**（上午/下午）、**机房编号**（1/2/3 号）。选择完毕后，预约以追加模式写入 `order.txt`，状态标记为 `1`（审核中）：

```cpp
ofs.open(ORDER_FILE, ios::app);
ofs << "日期:" << date << "\t";
ofs << "时间段:" << interval << "\t";
ofs << "学生姓名:" << this->name << "\t";
ofs << "学生学号:" << this->stu_id << "\t";
ofs << "预约的机房编号:" << room << "\t";
ofs << "状态:" << "1" << endl;   // 1 = 审核中
```

### 查看与取消预约

查看预约时，通过 `orderFile` 类从文件中读取所有预约记录，筛选出当前学生的学号对应的记录，并按状态码翻译成中文显示。取消预约则是将对应记录的状态改为 `0`（已取消），然后调用 `update_order()` 将整个容器写回文件。

```cpp
// 预约状态码的含义
// 0 = 已取消
// 1 = 审核中
// 2 = 预约成功
// -1 = 审核不通过
```

---

## 四、教师模块：审核预约

教师登录后可以查看所有预约记录，并对状态为 `1`（审核中）的记录进行审批。通过改为 `2`，不通过改为 `-1`：

```cpp
if (choice2 == 1)  // 通过
    of.map_order[v[choice1 - 1]]["状态"] = "2";
else if (choice2 == 2)  // 不通过
    of.map_order[v[choice1 - 1]]["状态"] = "-1";
of.update_order();  // 将修改写回文件
```

`update_order()` 做的事情是以 **trunc 模式**打开文件，将内存中 `map_order` 容器的所有数据重新写入——相当于"全量覆盖"而非"逐条修改"。这样做的好处是实现简单，代价是对于大量数据效率较低，但对于课程设计规模完全够用。

---

## 五、管理员模块：账号与机房管理

管理员除了查看机房信息、清空预约记录外，最核心的功能是**添加账号**。

添加账号时需要先选择类型（学生/教师），然后输入编号。这里有一个重要的细节——**重复性检查**：

```cpp
bool manager::checkRepeat(int id, int type)
{
    if (type == 1)  // 学生
    {
        for (auto it = v_stu.begin(); it != v_stu.end(); it++)
            if (id == it->stu_id)
                return true;   // 学号已存在
    }
    else  // 教师
    {
        for (auto it = v_tea.begin(); it != v_tea.end(); it++)
            if (id == it->tec_id)
                return true;   // 职工号已存在
    }
    return false;
}
```

管理员构造时会调用 `init_vector()`，把 `student.txt` 和 `teacher.txt` 中的所有数据读进 `v_stu` 和 `v_tea` 两个 vector 容器中，然后 `checkRepeat()` 遍历容器检查是否重复。添加成功后，新账号同时写入文件和容器，保持两边一致。

---

## 六、预约数据存储：`order_file` 的键值对设计

预约文件 `order.txt` 每一行的格式是：

```
日期:1	时间段:2	学生姓名:bob	学生学号:1	预约的机房编号:3	状态:-1
```

字段名和值之间用冒号分隔，字段之间用 Tab 分隔。`orderFile` 类的构造函数负责解析：

```cpp
// 核心数据结构：map<int, map<string, string>>
//   int → 记录序号
//   map<string, string> → {"日期":"1", "时间段":"2", ...}
map<int, map<string, string>> map_order;
```

解析过程用 `find(":")` 定位冒号位置，`substr()` 切出键和值，然后插入内层 map。这种设计使得每条记录的每个字段都可以通过 `map_order[序号]["字段名"]` 直接访问，修改单个字段（如审核结果）非常方便。

---

## 七、内存管理优化：从裸指针到智能指针

项目最初使用裸 `new`/`delete` 管理对象生命周期。这存在隐患——`login_menu.cpp` 中如果程序走了非预期的退出路径（如 `exit(0)`），`delete` 不会被调用，造成内存泄漏。

### 改动前

```cpp
// login_menu.cpp
user *person = NULL;
person = new student(id, name, password);
student_menu(person);   // student_menu 内部靠手动 delete 释放

// mian.cpp
case 0:
    exit(0);            // 直接终止进程，栈不展开，对象不析构
```

### 改动后

```cpp
// login_menu.cpp
unique_ptr<user> person;
person = make_unique<student>(id, name, password);
student_menu(person);   // unique_ptr 离开作用域自动释放

// mian.cpp
case 0:
    return 0;           // 正常返回，栈展开 → unique_ptr 析构 → 内存释放
```

三处关键改动：

1. **头文件**：函数参数从 `user *&` 改为 `unique_ptr<user>&`
2. **创建对象**：`new` → `make_unique`
3. **释放对象**：删除手动 `delete`，依赖 `unique_ptr` 自动析构

> **为什么不用析构函数解决？** 因为泄漏的原因是对象根本没被 `delete`，析构函数根本没机会执行。问题出在"谁来调用 delete"，而不是"删的时候没清干净"。`unique_ptr` 把"谁来 delete"变成了编译器的责任。

---

## 总结

这个项目虽然体量不大，但完整覆盖了 C++ 面向对象编程的核心流程：

```
继承设计角色体系 → 文件流读写数据 → STL 容器管理内存数据 → 智能指针管理生命周期
```

对于 C++ 初学者来说，这种"控制台 + 文件存储 + 角色权限"的项目是一个很好的练手选择——不需要图形界面，不需要数据库，一块一块地写，跑起来就能看到结果。

> 完整源代码见 GitHub 仓库：[engineer-05/Computer-Room-Reservation-System](https://github.com/engineer-05/Computer-Room-Reservation-System)
