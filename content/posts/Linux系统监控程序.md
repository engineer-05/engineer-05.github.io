---
date: '2026-08-11T14:00:00+08:00'
draft: false
title: '基于生产者消费者模型的Linux系统监控程序'
categories: ['学习记录']
tags: ['C语言', 'Linux', '多线程', '生产者消费者', '环形缓冲区', 'pthread', 'MySQL']
---

## 前言

学了 Linux 系统编程之后，一直想做点"能跑在服务器上、真的有用"的程序。想来想去，监控自己的 Linux 机器最合适——读 `/proc` 里的内核数据、算 CPU 和内存使用率、把数据存起来看趋势，每一步都能落到刚学的知识点上。

于是写了这个 SystemMonitor：一个 C 语言实现的 Linux 系统资源监控采集端，核心是一条**生产者—消费者**流水线——Producer 线程从 `/proc` 采集数据，送进线程安全的**环形缓冲区**，Consumer 线程取出来批量写入 MySQL。

项目地址：[engineer-05/SystemMonitor](https://github.com/engineer-05/SystemMonitor)。这篇文章记录整个设计过程，重点放在最核心的多线程协作上：为什么采集和写库要拆成两个线程？环形缓冲区怎么做到线程安全？收到 Ctrl+C 之后程序如何有序退出？

---

## 一、项目总览：一条监控数据的"一生"

先看整体数据流：

```
/proc/stat + /proc/meminfo        ← 数据源：内核暴露给用户态的"窗口"
             │
             ▼
      Producer 线程               ← 每 ~100ms 采集一次 CPU/内存
             │
             ▼
  RingBuffer（容量 64）           ← 线程安全缓冲，削平速度差
             │
             ▼
      Consumer 线程               ← 取出数据，攒批
             │
             ▼
  MySQL monitor_data 表           ← 每 10 条一次多行 INSERT
```

程序拆成五个模块，每个文件只干一件事：

| 文件 | 职责 |
|:---|:---|
| `monitor.c` | 数据采集：读 `/proc/stat`、`/proc/meminfo`，计算 CPU/内存使用率 |
| `ringbuffer.c` | 线程安全环形缓冲区：mutex + 条件变量 + shutdown 标志 |
| `producer.c` | 生产者线程：采集 → `ring_push` |
| `consumer.c` | 消费者线程：`ring_pop` → 打印 + 攒批落库 |
| `storage.c` | MySQL 存储：连接、批量 INSERT、退出时 flush |
| `main.c` | 组装：信号处理 → 建缓冲 → 起双线程 → 等待 → 清理 |

程序运行起来一共有三个线程，各司其职：

```
主线程（main.c）       —— 注册信号、建缓冲、创建两个工作线程后 join 等待退出
Producer 线程         —— 采集 CPU/内存，推入环形缓冲区
Consumer 线程         —— 从环形缓冲区取出数据，攒批写入 MySQL（连接只在这个线程用）
```

MySQL 连接虽然是主线程创建的，但创建后只传给 Consumer 线程使用，主线程和 Producer 都不碰它——这一点在第三节还会专门讲为什么。

有一点要提前交代：这个仓库是纯**采集端**，不含 Web 展示。后来为了让监控数据能在浏览器里看折线图，我又在另一个项目（HTTP 服务器）里加了 `GET /api/data` 接口和 Chart.js 仪表盘，两篇联动会在第六节简述，这里先把采集端讲透。

---

## 二、数据从哪来：/proc 伪文件系统

Linux 的 `/proc` 是一个"伪文件系统"——里面的"文件"不占磁盘，读它们等于读内核的实时状态。监控程序的数据源就两个：`/proc/stat` 和 `/proc/meminfo`。

### 2.1 CPU 使用率：两次采样的差值

`/proc/stat` 的第一行长这样：

```
cpu  168304 1276 34136 9684076 11044 0 8123 0 0 0
```

这 7 个数字是 CPU 在各种状态下**累计消耗的节拍数**（jiffies，从系统开机算起）：

| 字段 | 含义 |
|:---|:---|
| user | 用户态时间 |
| nice | 低优先级用户态时间 |
| system | 内核态时间 |
| idle | 空闲时间 |
| iowait | 等待 I/O 完成的时间 |
| irq / softirq | 硬/软中断处理时间 |

关键点在于：**这些是"里程表"式的累计值，而不是"速度表"**。单看一次读数没有任何意义——想知道"这一秒 CPU 忙不忙"，必须读两次、算差值。这就是代码里 `get_cpu_usage()` 做的事：先读一次，睡 50ms，再读一次：

```c
CPUTime start = get_cpu_time();     // 第一次读数
usleep(CPU_INTERVAL_US);            // 间隔 50ms
CPUTime end   = get_cpu_time();     // 第二次读数

// 两次之间 CPU 总共经过的时间
unsigned long long total_diff = end_total - start_total;
// 其中"空闲"增加了多少（idle 和 iowait 都算不干活）
unsigned long long idle_diff =
    (end.idle + end.iowait) - (start.idle + start.iowait);

// CPU使用率 = (总时间 - 空闲时间) / 总时间
return (float)(total_diff - idle_diff) / total_diff * 100;
```

两个设计细节值得说：

**为什么把 `iowait` 算作空闲？** `iowait` 是 CPU 干等着磁盘/网络 I/O 完成的时间——CPU 本身并没有在计算。从"CPU 忙不忙"的角度看，等待 I/O 的 CPU 和睡觉的 CPU 一样没有产出，所以一并算进分子减去。这也是各种监控工具（top 等）的通用口径。

**为什么要 `usleep` 而不是连续读两次？** 采样间隔太短，两次读数的差值会小到失真（甚至为 0——代码里专门判断 `total_diff == 0` 直接返回 0，防除零）。50ms 的间隔让差值有足够的统计意义。

### 2.2 内存使用率：MemTotal vs MemAvailable

`/proc/meminfo` 里内存相关的行很多，程序只挑两行：

```
MemTotal:       16313828 kB
MemFree:         6043776 kB
MemAvailable:   13547464 kB
```

注意用的是 **MemAvailable** 而不是更直观的 MemFree——这是 Linux 内存语义里最容易踩的坑：MemFree 只是"完全没被用"的页，而 Linux 会拿空闲内存做页缓存（page cache），一旦程序需要内存，缓存可以立刻让出来。用 MemFree 算使用率，会把系统误判成"内存快满了"，实际上系统状态很健康。**MemAvailable 才是"在不触发换页的前提下还能分配多少内存"的估算值**，用它当"可用"更符合直觉。

```c
float usage = (float)(mem_total - mem_available) / mem_total * 100;
```

采集端把 CPU、内存和时间戳打包成一个 `MonitorData` 结构，一次采样就完成了：

```c
typedef struct
{
    float cpu_usage;    // CPU 使用率（%）
    float mem_usage;    // 内存使用率（%）
    long  timestamp;    // 采集时间
} MonitorData;
```

---

## 三、核心架构：生产者—消费者与环形缓冲区

### 3.1 为什么需要中间缓冲区？

最朴素的写法是单线程：采集 → 立刻写库 → 再采集。但仔细想，这两个动作的"脾气"完全不一样：

- **采集**：快、频繁——每 100ms 一次，每次只是读文件算几个数；
- **写库**：慢、偶发——一次 MySQL 交互要走网络协议、SQL 解析、磁盘写入，动辄几毫秒到几十毫秒。

单线程串行的话，写库的慢会直接把采集周期拖长——采一次等一次，采样频率被数据库的屁股拖住。更重要的是职责耦合：采集逻辑和存储逻辑挤在一个循环里，将来想换存储、调采样频率，都互相牵连。

所以拆成**生产者—消费者**双线程，中间放一个缓冲区：

```
Producer（快，负责采集） → RingBuffer（容量64） → Consumer（慢，负责写库）
```

生产者只管"采得快"，塞进缓冲区就回去采下一条，绝不等数据库；消费者只管"慢慢写"，缓冲区里有数据就取出来写。**两个线程通过缓冲区解耦，各自按自己的节奏工作**——这就是教材里生产者—消费者模型的工程价值：缓冲即削峰。

### 3.2 环形缓冲区：固定大小，头尾相接

为什么选环形缓冲区而不是队列链表？因为这里的数据是定长结构体、读写都是纯内存操作，**固定数组 + 头尾指针**就够用了：不涉及动态分配、没有内存碎片，入队出队都是 O(1)，还天然限制住了缓冲上限（防止生产者疯跑时内存无界增长）。

```c
#define BUFFER_SIZE 64

typedef struct
{
    MonitorData buffer[BUFFER_SIZE];  // 定长数组
    int head;       // 下一个写入位置
    int tail;       // 下一个读取位置
    int count;      // 当前元素个数

    pthread_mutex_t mutex;            // 保护上面的共享状态
    pthread_cond_t  cond_not_empty;   // "缓冲区非空"条件变量
    pthread_cond_t  cond_not_full;    // "缓冲区未满"条件变量
    int shutdown;                     // 退出标志，信号来时置 1
} RingBuffer;
```

两个条件变量分别伺候两个方向：生产者往满的缓冲区里写时要等 `cond_not_full`；消费者从空的缓冲区里读时要等 `cond_not_empty`。`count` 的存在让"空/满"的判断不用比较 head 和 tail 的微妙关系，`shutdown` 标志则是优雅退出的关键（第四节详述）。

### 3.3 条件变量：等待的标准姿势

看生产者的 `ring_push`——它是整个缓冲区里最值得细读的函数：

```c
int ring_push(RingBuffer *rb, MonitorData data)
{
    pthread_mutex_lock(&rb->mutex);

    // shutdown 时不必等待，buffer 满也不再等，立刻退出循环
    while (!rb->shutdown && ring_full(rb))
    {
        pthread_cond_wait(&rb->cond_not_full, &rb->mutex);
    }

    // 退出原因 B：shutdown 且 buffer 满 → 放弃写入，返回 -1
    if (rb->shutdown && ring_full(rb))
    {
        pthread_mutex_unlock(&rb->mutex);
        return -1;
    }

    // 退出原因 A：buffer 有空位 → 正常写入
    rb->buffer[rb->head] = data;
    rb->head = (rb->head + 1) % BUFFER_SIZE;   // 头指针绕回起点
    rb->count++;

    pthread_cond_signal(&rb->cond_not_empty);  // 告诉消费者：有货了
    pthread_mutex_unlock(&rb->mutex);
    return 0;
}
```

三个教科书级的细节：

**① 等待条件要用 `while` 而不是 `if`。** `pthread_cond_wait` 被唤醒后，条件不一定真的成立了——可能是"伪唤醒"（spurious wakeup），也可能是另一个线程抢先一步把空位占了。所以必须 `while` 循环重新检查条件，不成立就继续等。这是 POSIX 条件变量的铁律。

**② `while` 退出之后还要用 `if` 判断"为什么退出"。** 这是这个实现最巧妙的地方：退出 `while` 有两种原因——A) 缓冲区有空位了，正常写入；B) `shutdown` 标志被置位、不该再等了。如果不加这个 `if`，shutdown 时生产者还会傻傻地往缓冲里塞最后一条数据，破坏退出时序。**"等待循环"和"退出原因判断"是两件事**，很多初版实现都漏了后者。

**③ `signal` 还是 `broadcast`？** 正常入队只唤醒一个消费者（`signal`）就够；但 `shutdown` 时必须用 `broadcast` 把所有可能阻塞在条件变量上的线程全部唤醒——否则可能有一个线程永远睡在 `cond_wait` 里，程序退不出去。所以 `ring_shutdown` 里广播两个条件变量：

```c
void ring_shutdown(RingBuffer *rb)
{
    pthread_mutex_lock(&rb->mutex);
    rb->shutdown = 1;
    pthread_cond_broadcast(&rb->cond_not_empty);
    pthread_cond_broadcast(&rb->cond_not_full);
    pthread_mutex_unlock(&rb->mutex);
}
```

`ring_pop` 的逻辑与 `ring_push` 完全对称，同样是"while 检查 → if 判断退出原因 → 正常取出 → signal 通知生产者有空位"。

### 3.4 一个容易忽略的设计：MySQL 连接只属于消费者

程序里 MySQL 连接是在 `main` 里创建、只传给 Consumer 线程用的。这是刻意的：**libmysqlclient 的同一连接不能跨线程并发使用**，如果生产者也拿这个连接去写库，就要给连接加锁，反而把简单问题搞复杂。

把"谁碰数据库"限定为唯一的消费者线程之后，连接天然单线程使用，不需要任何额外同步。这也是分层的收益——**职责边界划清楚了，线程安全问题的范围就缩小了**。

---

## 四、优雅退出：信号 → shutdown → 排空 → flush

`Ctrl+C` 按下去会发生什么？默认行为是进程直接终止——如果恰好在写数据库，可能留下半截数据。这个程序实现了**有序退出**，整条链路环环相扣：

```
用户按 Ctrl+C（SIGINT）
    ↓
信号处理函数：running = 0；ring_shutdown() 广播唤醒所有等待线程
    ↓
Producer 循环条件 running 为假 → 停止采集（不再向缓冲区放数据）
Consumer 继续从缓冲区取数据，取空后（shutdown 且空）退出
    ↓
main 中 pthread_join 回收两个线程
    ↓
storage_flush()：把攒批缓存里不足 10 条的剩余数据也写进 MySQL
    ↓
关闭连接、销毁缓冲区，程序正常退出
```

信号处理函数全貌只有三行：

```c
volatile sig_atomic_t running = 1;   // 线程退出标志，信号处理函数置 0

static void signal_handler(int sig)
{
    (void)sig;
    running = 0;
    ring_shutdown(&buffer);
}
```

两个要点：

**为什么信号处理函数里只做这两件事？** 信号处理函数运行在"半路杀出"的上下文里，只能调用**异步信号安全**的函数——像 `printf`、`malloc`、`pthread_cond_signal` 这类都不能直接用，否则可能死锁或破坏内部状态。所以处理函数只做两件绝对安全的事：置一个 `volatile sig_atomic_t` 标志，以及调用我们自己写的、只加锁改标志的 `ring_shutdown`。**把"收到信号"和"真正清理"拆开，是信号处理的通用套路**——处理函数负责通知，主流程负责干活。

**为什么 `ring_shutdown` 用锁是安全的？** 它锁的 mutex 在正常流程里也会被 `ring_push`/`ring_pop` 持有；万一信号到达时某线程正持锁写缓冲区，处理函数会等锁释放再置位——不会和业务代码互踩。虽然信号处理函数里加锁理论上仍有风险（如果信号恰好打断持锁线程自身就会死锁），但对这种"从主线程信号上下文唤醒工作线程"的用法，配合广播唤醒，是这个规模下最简洁可靠的方案。

`storage_flush` 是链条的最后一环：批量缓存可能攒了 3 条、7 条——不够 10 条就不会触发自动提交。退出前必须把这"零头"也写进库，否则这批数据就无声无息地丢了：

```c
void storage_flush(MYSQL *conn)
{
    if (g_batch.count == 0) return;      // 没有残留，直接返回
    if (insert_rows(conn, g_batch.count) != 0) { ... }
    g_batch.count = 0;
}
```

---

## 五、攒批写库：10 条拼一条 SQL

Consumer 每取出一条数据就单独 `INSERT` 一次？那 100ms 一条就是每秒 10 次网络往返，太浪费。这里的做法是**攒批**：Consumer 取出的数据先放进模块内部的攒批数组，凑满 10 条才拼一条多行 INSERT 执行一次：

```c
// 批量缓冲区（模块内部使用）
static struct
{
    float     cpu_data[BATCH_SIZE];
    float     mem_data[BATCH_SIZE];
    long long ts_data[BATCH_SIZE];
    int       count;
} g_batch = { .count = 0 };
```

```c
// 把 10 条数据拼成一条 SQL：
// INSERT INTO monitor_data(cpu_usage,mem_usage,timestamp)
//   VALUES (1.23,45.67,1234567890),(2.10,46.00,1234567990),...
```

一次 `mysql_query` 写 10 行，网络往返从 10 次变成 1 次，SQL 解析也只做一遍。这是"批量提交"最朴素也最有效的形态——**减少交互次数，比优化单次交互更划算**。

攒批缓冲是模块内的静态变量、只被消费者线程触碰，所以不需要额外的锁。写入失败的兜底目前是直接丢弃（代码注释里写明"后续可以改为写入文件兜底"），这是 README 里诚实列出的限制之一——本项目定位是学习实践，尚未达到生产级可靠性。

---

## 六、与 HTTP 服务器的联动：监控数据上 Web

采集端写完，数据全躺在 MySQL 里，只能命令行查。于是让监控数据"可视化"的想法就来了——但 Web 服务不该塞进采集程序里（采集端要轻、要稳），正确姿势是**通过数据库解耦**：SystemMonitor 只负责写库，另一个项目负责读库展示：

```
SystemMonitor（写）──► monitor_data 表 ◄──（读）http-server ──► 浏览器图表
   采集 CPU/内存，攒批落库              每 2 秒 GET /api/data（查最近 60 条）
```

三个角色的分工是：

- **SystemMonitor（本文，采集端）**：Producer/Consumer 线程把 CPU、内存数据攒批写入 `monitor_data` 表，写到这步任务就完成了；
- **http-server（另一项目，展示端）**：新增的 `GET /api/data` 接口负责读——查询 `monitor_data` 表最近 60 条记录，拼成 JSON 返回给浏览器；
- **浏览器**：仪表盘页面（`dashboard.html`）用 Chart.js 把 JSON 画成 CPU/内存折线图，每 2 秒轮询一次接口，曲线自动刷新。

整套 Web 展示端的实现细节写在另一篇文章里：[《基于epoll的HTTP服务器》](/posts/c语言http服务器/)。

两个项目一采一展、通过一张 MySQL 表衔接，谁都不需要知道对方的存在——**数据库在这里充当了两个项目间的解耦层**，这也是当时顺手就用 MySQL、而不是额外引入消息中间件的原因。

---

## 七、编译运行与验证

编译依赖 MySQL 客户端库，Ubuntu 下安装后直接编：

```bash
sudo apt install build-essential default-libmysqlclient-dev mysql-server

gcc -std=c11 -Wall -Wextra -Wpedantic \
    main.c monitor.c producer.c consumer.c ringbuffer.c storage.c \
    -o main -pthread -lmysqlclient
./main
```

数据库需要先建好表（连接参数在 `config.h` 里，运行前按本机环境改，尤其别把真实密码提交到公开仓库）：

```sql
CREATE DATABASE system_monitor;
USE system_monitor;

CREATE TABLE monitor_data (
    id         BIGINT AUTO_INCREMENT PRIMARY KEY,
    cpu_usage  FLOAT    NOT NULL COMMENT 'CPU 使用率（%）',
    mem_usage  FLOAT    NOT NULL COMMENT '内存使用率（%）',
    timestamp  BIGINT   NOT NULL COMMENT '采集 Unix 时间戳',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

运行后控制台的日志就是两条线程的实时"心电图"——注意 `[Producer]` 和 `[Consumer]` 交替出现、互不阻塞：

```
[Storage] MySQL connected: lzx@localhost/system_monitor (batch=10)
[Producer] push data
[Consumer] CPU: 12.34%, Mem: 45.60%, Time: 1752111234
[Producer] push data
[Consumer] CPU: 11.02%, Mem: 45.62%, Time: 1752111235
...（Ctrl+C 按下）...
[Producer] exit              ← 生产者先停
[Consumer] exit              ← 消费者排空缓冲后停
[Storage] flush: 3 rows      ← 不足一批的残留数据被刷库
[Storage] MySQL disconnected
[Main] exit
```

退出日志里那条 `flush: 3 rows` 就是优雅退出链条的证明——**3 条没凑够 10 条的数据没有丢**。最后用 SQL 抽查落库结果：

```sql
SELECT cpu_usage, mem_usage, FROM_UNIXTIME(timestamp)
FROM monitor_data ORDER BY id DESC LIMIT 5;
```

---

## 总结

写这个项目最大的收获，是把课本上的三个知识点真正"跑"了起来：

**生产者—消费者模型不是纸上谈兵，而是性能问题的自然答案。** 单线程串行时，慢速的数据库会拖住高频采集；拆成两个线程、中间放一个环形缓冲区，快慢双方立刻各得其所。这个模型之所以经典，是因为现实里"快生产者 + 慢消费者"无处不在——不仅是监控采集，日志收集、消息队列都是同一个套路。

**线程安全的难点不在锁，而在"等待与唤醒的边界条件"。** `while` 检查防止伪唤醒、`signal`/`broadcast` 的选择、shutdown 标志与条件变量的配合——每个细节都是并发 bug 的高发区，也是这次最容易写错、调试最久的地方。写完 `ring_push`/`ring_pop` 再回头看，才明白教材强调"条件变量必须配 while"的原因。

**退出路径和主路径一样需要设计。** Ctrl+C 按下之后的十毫秒，才是区分"能跑"和"可靠"的分水岭：信号处理函数只做通知、生产者先停、消费者排空、`flush` 兜底零头数据——每一环都有明确职责，环环相扣才有那份干净利落的退出日志。

| 技术点 | 具体应用 |
|:---|:---|
| **/proc 采集** | `/proc/stat` 两次采样差分算 CPU 使用率，`/proc/meminfo` 的 MemAvailable 算内存使用率 |
| **生产者—消费者** | 采集（快）与写库（慢）解耦，缓冲削峰，各按各的节奏工作 |
| **线程安全环形缓冲区** | 定长数组 + head/tail/count，mutex + 两个条件变量 + shutdown 标志 |
| **条件变量规范** | while 循环防伪唤醒、while 后 if 判断退出原因、shutdown 用 broadcast |
| **信号处理** | SIGINT/SIGTERM/SIGQUIT/SIGHUP 只置标志并广播唤醒，主流程负责清理 |
| **优雅退出** | 停生产 → 排空缓冲 → `storage_flush` 兜底不足一批的数据 |
| **MySQL 批量写入** | 攒批 10 条拼一条多行 INSERT，交互次数降为 1/10 |

项目定位是学习实践，README 里也如实列了当前限制：MySQL 凭据硬编码在头文件、写库失败直接丢弃没有重试与文件兜底、只有条数阈值没有定时刷写、SQL 用字符串拼接而非预处理语句。这些恰好就是下一步可以继续练习的方向——把一个"能跑"的采集程序打磨成"可靠"的采集程序。

> 完整源代码见 GitHub 仓库：[engineer-05/SystemMonitor](https://github.com/engineer-05/SystemMonitor)
