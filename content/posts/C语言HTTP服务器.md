---
date: '2026-07-30T14:00:00+08:00'
draft: false
title: '基于epoll的HTTP服务器'
categories: ['学习记录']
tags: ['C语言', '网络编程', 'Socket', 'HTTP', 'epoll', 'I/O多路复用', 'Linux']
---

## 前言

学完 Linux 系统编程之后，最大的感受是：`socket`、`bind`、`listen`、`accept`、`epoll` 这些接口一个个都认识，但课本不会告诉你它们是怎么组合起来，变成一个真正"跑在网络上的程序"的。于是我把这个 HTTP 服务器当作学习导向的阶段性练习——不借助任何 Web 框架，从监听 socket 到 HTTP 响应头全部手写，把文件 I/O、TCP socket 编程、I/O 多路复用、HTTP 协议这些零散的知识点，串成一个浏览器能直接访问的系统。

项目用纯 C 实现，支持静态文件服务、目录浏览、Keep-Alive 长连接，监听 8080 端口，浏览器输入地址就能看到页面。写完这个项目，再回头看浏览器里每天访问的那些网站，背后发生了什么就有了具体的答案。

项目地址：[engineer-05/http-server](https://github.com/engineer-05/http-server)。代码量不大（全部约 800 行，零第三方运行时依赖），但"网络编程该踩的坑基本都踩了一遍"。另外还要交代一句：这个仓库里的 `GET /api/data` 接口和仪表盘页面，其实源自另一个项目——Linux 系统资源监控程序 [SystemMonitor](https://github.com/engineer-05/SystemMonitor)。它把监控的 CPU/内存数据写进 MySQL，又想搬到 Web 上展示，正好这个服务器有了 HTTP 能力，就顺手把数据接口写了进来。它属于两个项目的顺带集成，不是本文重点，下文只简单带过。

整个项目里最值得单独写一篇文章的，是网络编程从入门走向进阶的分水岭——**并发模型**：一个进程怎么同时伺候成千上万个连接？答案就是 Linux 上的 **epoll（I/O 多路复用）**。这是学习系统编程时公认最难啃的一块，下文就从它要解决的问题讲起，中间把它的两位前辈 `select`、`poll` 也拿出来对比，看看 epoll 究竟赢在哪里。

---

## 一、项目总览：一个请求的完整旅程

先看整体架构。在浏览器输入 `http://localhost:8080/` 按下回车，服务器内部经历了这样一条链路：

```
浏览器
  ↓ HTTP 请求（GET / HTTP/1.1）
监听 socket（accept 出客户端连接）
  ↓ epoll 通知"有数据可读"
读取请求 → 解析请求行（方法 / URL / 版本）
  ↓ 路由分发
  ├─ /api/data → 读 SystemMonitor 的监控数据 → JSON 响应（顺带集成）
  └─ 其他路径 → 磁盘文件 → MIME 检测 → 文件内容
  ↓
构造响应（状态行 + 响应头 + 响应体）
  ↓ send 回浏览器
Keep-Alive？→ 保持连接等下一个请求 / 断开
```

对应到代码，项目被拆成了职责清晰的 5 个文件：

| 文件 | 职责 |
|:---|:---|
| `server.c` | 网络层：socket 创建、bind、listen、accept、非阻塞设置 |
| `main.c` | 主循环：**epoll 事件处理 + Keep-Alive 超时管理** |
| `http.c` | HTTP 协议：请求行解析、响应构造、路由分发、Connection 头判断 |
| `file.c` | 文件服务：MIME 检测、路径安全检查、目录浏览 |
| `api.c` | API 层：读取 SystemMonitor 写入 MySQL 的监控数据，返回 JSON（顺带集成） |

写的时候是按 6 步迭代推进的，每一步都能编译、能运行、能验证：

```
① TCP Echo 服务器（先让数据通起来）
② 解析 HTTP 请求行（把"你好"变成真正的协议）
③ 构造 HTTP 响应（状态行 + 响应头 + 空行 + 响应体）
④ 静态文件服务（浏览器能看到真实页面了）
⑤ epoll I/O 多路复用（从单连接升级到高并发）
⑥ Keep-Alive / HEAD / 目录浏览 / Makefile / 接入 SystemMonitor 的 API + 仪表盘
```

第 ①～④ 步是"把 HTTP 跑通"，第 ⑤ 步才是把服务器从"玩具"变成"能扛并发"的关键。本文重点讲第 ⑤ 步背后的道理。

---

## 二、并发之痛：为什么需要 I/O 多路复用

先看一个最朴素的服务器写法——单线程，阻塞式：

```c
while (1)
{
    int client_fd = accept(server_fd, ...);   // 阻塞等待新连接
    char buf[4096];
    int n = recv(client_fd, buf, sizeof(buf), 0);  // 阻塞等数据
    handle_request(client_fd, buf);                // 处理
    close(client_fd);
}
```

这个模型有一个致命的死穴：**`recv` 是阻塞的**。当一个客户端连接上之后迟迟不发数据（或者网速很慢、数据要很久才传完），服务器就卡在 `recv` 上——后面排队的连接全部被堵死。一个"不听话"的客户端就能让整个服务器瘫痪。

换个思路，一个客户端开一个线程？

```c
while (1)
{
    int client_fd = accept(server_fd, ...);
    pthread_create(&tid, NULL, handle_conn, &client_fd);  // 每连接一线程
}
```

问题变成了：**线程是有成本的**。每个线程要占独立的栈空间（默认 8MB 虚拟内存），创建/切换都要开销。C10K 问题（一万并发连接）意味着要一万个线程——单机根本撑不住。而且绝大多数连接是"挂机状态"：连上了但不发数据，线程白白占着资源睡觉。

**问题本质**：程序要同时等待成千上万个 fd，但绝大多数时间它们都没有动静。我们需要的不是"每个 fd 配一个执行流"，而是**一个执行流能同时监视所有 fd，谁有动静就处理谁**——这就是 I/O 多路复用。

> 注意区分两个概念：**阻塞 I/O**（等一个 fd，来数据前线程睡觉）和**多路复用**（同时监视很多 fd，任何一个就绪就通知程序）。多路复用是"一对多"地等待，它本身通常配合非阻塞 I/O 使用。

Linux 上实现"一对多等待"的系统调用有三个：`select`、`poll`、`epoll`。它们解决的问题相同，效率却差了整整一个时代。

---

## 三、select：能等，但很笨重

`select` 是最古老的多路复用接口（1983 年就有了）。它的思路是：把要监视的 fd 放进一个**位图**，交给内核去轮询，谁就绪了就返回"有几个就绪"，程序再自己逐个检查：

```c
fd_set readfds;
FD_ZERO(&readfds);
FD_SET(server_fd, &readfds);   // 把要监视的 fd 对应的位设成 1

int n = select(max_fd + 1, &readfds, NULL, NULL, NULL);
// 返回后，程序必须自己遍历所有 fd，用 FD_ISSET 判断哪个就绪
for (int i = 0; i <= max_fd; i++)
    if (FD_ISSET(i, &readfds))
        handle(i);
```

代码一眼能看出三个问题：

**问题 1：数量上限。** fd_set 是固定大小的位图，`FD_SETSIZE` 通常是 1024——监视的连接数超过 1024 就无能为力了。想扩大得改内核宏重新编译，很不现实。

**问题 2：每次调用都要全量拷贝。** 用户态把整个位图复制给内核，内核轮询完再整体拷回来。一万个连接、绝大多数没动静，也得把这上万比特来回搬。

**问题 3：O(n) 双重扫描。** 内核要线性扫描全部 fd 判断哪些就绪；返回后用户态还要再扫一遍找出就绪的。而且 `select` 的返回值只是个"就绪总数"——**内核不告诉你具体是哪个**，程序只能自己全扫一遍碰运气。

还有个隐蔽的坑：`select` 会**修改传入的 fd_set**（把没就绪的位清掉），所以每次调用前都必须重新 `FD_ZERO` + `FD_SET` 重建整个集合。

结论：select 适合监视几十个连接的教学场景。连接一多，它就是性能瓶颈本身。

---

## 四、poll：去掉了上限，没去掉低效

`poll`（1997 年）针对 select 最明显的痛点做了改进——用**动态数组** `pollfd` 取代固定位图：

```c
struct pollfd fds[MAX_CONN];
fds[0].fd = server_fd;
fds[0].events = POLLIN;    // 要监视的事件
// ...

int n = poll(fds, nfds, -1);
// 返回后遍历数组，检查 revents
for (int i = 0; i < nfds; i++)
    if (fds[i].revents & POLLIN)
        handle(fds[i].fd);
```

**上限问题解决了**——pollfd 数组的长度只受内存限制，可以监视几万个 fd。每个 fd 还能单独指定关心的事件类型（读/写/异常），比 select 只能"一刀切"地监视可读更精细。

但本质问题一个没解决：

- **每次调用依然要全量拷贝**：整个 pollfd 数组（可能几万个元素）在用户态和内核态之间来回搬运，O(n) 无处可逃；
- **内核依然线性扫描全部 fd**：每次 poll 都要重新检查所有 fd 的状态，不管它们多久没动静；
- **监听集合和就绪集合共用同一个数组**：内核靠 `revents` 字段回写结果，所以每次调用前要把所有 `revents` 清零，返回后用户态还是要遍历整个数组挑就绪的。

select 和 poll 共用一个形象的比喻：**每次开会都要把所有参会者重新点一遍名，问"你有没有事？"**——哪怕大部分人上次开会到现在一直在睡觉。人数少无所谓，人数上万，点名本身就成了最耗时的环节。

---

## 五、epoll：内核记住了你

`epoll`（2002 年，Linux 2.6 内核引入）把整个思路反转过来：**让内核长期记住你要监视的 fd，只在有事件发生时通知你**。它由三个系统调用组成：

```c
int epfd = epoll_create1(0);          // ① 创建 epoll 实例（内核中的一棵红黑树）

struct epoll_event ev;
ev.events = EPOLLIN;                  // 关心"可读"事件
ev.data.fd = server_fd;

epoll_ctl(epfd, EPOLL_CTL_ADD, server_fd, &ev);   // ② 增删改监视对象
epoll_ctl(epfd, EPOLL_CTL_DEL, client_fd, NULL);  //    EPOLL_CTL_ADD / MOD / DEL

int n = epoll_wait(epfd, events, MAX_EVENTS, 5000);  // ③ 等事件
for (int i = 0; i < n; i++)
    handle(events[i].data.fd);        // 返回的 events[] 里全是就绪的
```

和 select/poll 相比，epoll 有四个本质差异：

**1. 内核有"记忆"——增量维护，告别全量拷贝。** 添加、修改、删除监视对象通过 `epoll_ctl` 单独完成，内核把这些 fd 挂在一棵**红黑树**上。`epoll_wait` 的时候不再需要把整个监听集合拷进内核——**监听集合本来就在内核里**。连接从一万变成两万，只是往红黑树上插一万个节点的事，每次调用零拷贝负担。

**2. 就绪列表——内核只返回"有事的人"。** 内核里维护一条**就绪链表**，只有真正就绪的 fd 才会被挂上去。`epoll_wait` 返回时把就绪链表拷给用户——**返回多少个就处理多少个，处理完不用再遍历检查**。一万个连接只有 3 个有数据，就只返回 3 个，复杂度从 O(n) 降到 O(就绪数)。

**3. 回调机制——从"轮询问"变成"主动上报"。** select/poll 每次都要内核线性扫描所有 fd 问"你好了没"；epoll 则是在 fd 对应的设备驱动里注册了回调函数 `ep_poll_callback`——**socket 缓冲区一有数据到达，内核直接回调，把这个 fd 挂进就绪链表**。没有数据到达的 fd 根本不会被检查。

**4. 事件类型更丰富。** `EPOLLIN`（可读）、`EPOLLOUT`（可写）、`EPOLLRDHUP`（对端关闭）、`EPOLLERR`（出错）等可以按需组合，还能额外加 `EPOLLET` 切换边缘触发模式。

三者的关系可以总结成一句话：select/poll 是"**每次调用都把名单重抄一遍、挨个点名**"，epoll 是"**名单存内核，有事我喊你**"。前者是过程式地"查"，后者是事件驱动地"通知"——这正是"多路复用"三个字从笨重走向高效的转折点。

### 补充：水平触发（LT）和边缘触发（ET）

epoll 有两种触发模式，这个项目用的是默认的**水平触发 LT**：

- **LT（Level Triggered）**：只要缓冲区里还有数据没读完，`epoll_wait` 就会反复通知你。漏读的数据永远不会被"忘记"。
- **ET（Edge Triggered）**：只在状态**变化**的那一刻（从无数据变为有数据）通知一次。你必须一次把数据读干净（循环读直到返回 `EAGAIN`），否则剩下的数据再也不会触发通知。

LT 用着省心——"读了一次没读完？没关系，内核下次还会提醒你"。ET 效率更高（通知次数更少），但对程序员的读写逻辑要求苛刻得多。这个项目的定位是学习和演示，用 LT 配合单次 `recv` 完全够用，代码也简单清晰；等以后要追求极致性能，再上 ET 也不迟。

---

## 六、选型对比：为什么这个项目选 epoll

把三代接口放到同一张表里对比，差距一目了然：

| 维度 | select | poll | epoll |
|:---|:---|:---|:---|
| 底层结构 | fd_set 位图 | pollfd 数组 | 红黑树 + 就绪链表 |
| 连接数量上限 | FD_SETSIZE（默认 1024） | 无（受内存限制） | 无（受内存限制） |
| 监听集合存放 | 用户态，每次调用拷贝进内核 | 用户态，每次调用拷贝进内核 | **内核态，epoll_ctl 增量维护** |
| 内核检测方式 | 每次线性扫描全部 fd | 每次线性扫描全部 fd | **回调 + 就绪链表，只碰就绪的** |
| 返回就绪结果 | 只给总数，用户态再全扫 | 遍历全部数组看 revents | **只返回就绪的 fd 列表** |
| 每次调用开销 | O(n) 拷贝 + O(n) 扫描 | O(n) 拷贝 + O(n) 扫描 | **O(就绪数)** |
| 典型适用场景 | 连接少（<1024）且简单 | 连接较多、跨平台需求 | **海量连接、低活跃度（高并发服务器）** |

一句话概括 epoll 的优势：**在"连接数巨大但同一时刻活跃的连接很少"的场景下，epoll 的每次调用成本只和活跃连接数挂钩，和总连接数无关**。而 HTTP 服务器恰恰就是最典型的这种场景——成千上万浏览器挂着长连接，真正同时发请求的只有零星几个。这也是 Nginx、Redis 等高性能服务器在 Linux 上全部选择 epoll 的原因。

---

## 七、epoll 在项目中的落地：主循环拆解

### 7.1 三种对象，一套循环

`main.c` 的主循环用 epoll 统一管理三类 fd，全程只有一个 `while(1)`：

```
① 监听 socket fd   —— 有新连接到达 → accept，把新客户端注册进 epoll
② 客户端 fd       —— 可读 → recv 请求 → 处理 → Keep-Alive 决定去留
③ 定时清理        —— epoll_wait 5 秒超时返回 → 扫描客户端，超时的断开
```

**第一步：注册监听 socket。** 服务器启动后，把监听 fd 加入 epoll，只关心 `EPOLLIN`（有新连接到来也算"可读"）：

```c
int epfd = epoll_create1(0);

struct epoll_event ev;
ev.events = EPOLLIN;
ev.data.fd = server_fd;                     // data 里记住这是监听 fd
epoll_ctl(epfd, EPOLL_CTL_ADD, server_fd, &ev);

while (1)
{
    // 5000ms 超时：即使没事件也返回，给 Keep-Alive 超时检查的机会
    int nfds = epoll_wait(epfd, events, MAX_EVENTS, 5000);
    ...
}
```

**第二步：事件分发。** `epoll_wait` 返回后，根据 `events[i].data.fd` 区分两种场景——新连接，还是老客户端来数据了：

```c
for (int i = 0; i < nfds; i++)
{
    int ready_fd = events[i].data.fd;

    if (ready_fd == server_fd)
    {
        // 场景1：新客户端连接 → accept → 设为非阻塞 → 注册进 epoll
        int client_fd = server_accept(server_fd, &client_addr);
        set_nonblocking(client_fd);

        ev.events = EPOLLIN;
        ev.data.fd = client_fd;
        epoll_ctl(epfd, EPOLL_CTL_ADD, client_fd, &ev);
        add_client(clients, MAX_EVENTS, client_fd);   // 记录活跃时间
    }
    else
    {
        // 场景2：客户端发来了数据 → 读取并处理
        int n = recv(client_fd, buf, sizeof(buf) - 1, 0);
        if (n <= 0)   // 断开或出错 → 从 epoll 删除并关闭
        {
            epoll_ctl(epfd, EPOLL_CTL_DEL, client_fd, NULL);
            close(client_fd);
            remove_client(clients, MAX_EVENTS, client_fd);
        }
        else
        {
            int keep_alive = should_keep_alive(buf);
            handle_request(client_fd, buf);
            if (keep_alive)      // 不关连接，更新活跃时间，继续留在 epoll 里
                ...
            else                 // 明确要关闭 → DEL + close
                ...
        }
    }
}
```

几个值得注意的实现细节：

**为什么所有 socket 都要设非阻塞？** 因为 epoll 通知"可读"和真正去 `recv` 之间有时差，极端情况下数据可能已被别的机制取走，阻塞式 `recv` 会卡死整个事件循环。非阻塞 + 返回错误就跳过，是 epoll 编程的防御性标配。

**为什么 `epoll_wait` 的超时设成 5000ms？** 这恰好和 Keep-Alive 的 5 秒超时相等——epoll_wait 即使没有任何事件，最多 5 秒也会返回一次，主循环借此机会扫描一遍客户端列表，把太久没动静的连接清掉。**超时参数被复用成了"心跳时钟"**，一个 while 循环同时完成了事件驱动和定时清理两件事。

### 7.2 Keep-Alive：epoll 高并发价值的直接体现

如果每个请求处理完就 `close` 连接，服务器很快会被频繁的 TCP 三次握手/四次挥手拖垮。HTTP/1.1 的 Keep-Alive 让连接复用——同一个 TCP 连接上连续处理多个请求。判断逻辑遵循 HTTP 规范：

```
HTTP/1.1：默认保持连接，只有明确写 "Connection: close" 才关闭
HTTP/1.0：默认处理完即关，只有明确写 "Connection: keep-alive" 才保持
```

处理时有个容易踩的坑：**必须先判断 Keep-Alive，再交给请求解析函数**——因为解析函数会原地修改缓冲区（把空格、`\r` 替换成 `\0` 切出字符串），先解析就把原始的 Connection 头破坏了。代码里专门用了一个不修改原缓冲区的 `should_keep_alive()` 来做判断。

保持连接的客户端**不会从 epoll 里摘除**，而是留在就绪集合里等下一个请求到来。这就是 epoll 能撑起高并发的典型场景：**一万个客户端连上后不发请求，服务器不需要为它们做任何事（不占线程、不占 CPU），但任何一个发来请求，epoll 立刻就能把它找出来**。多路复用 + 长连接，正是现代 Web 服务器的并发基石。

项目用一个简单的结构体数组跟踪每个客户端的最后活跃时间，主循环每轮扫描，`now - last_active >= 5` 秒的就被判定为超时，从 epoll 删除并关闭：

```c
typedef struct {
    int fd;
    time_t last_active;
} Client;

Client clients[MAX_EVENTS];   // fd == -1 表示空闲槽位
```

为什么 Keep-Alive 超时设 5 秒而不是更长？这是工程上的权衡：太短会让浏览器复用的连接频繁失效，太长会让服务器积累大量僵尸连接。5 秒对本地演示和常规浏览都够用，README 的"后续计划"里也列了把线性数组改成哈希表来应对更大规模的连接数。

---

## 八、运行与验证：从日志观察事件流转

跑起来最能直观感受 epoll 的运作。启动服务器后，用 curl 模拟一次请求：

```bash
./http_server        # 启动，监听 8080

# 另一个终端
curl http://localhost:8080/
curl -I http://localhost:8080/index.html    # HEAD 请求
curl http://localhost:8080/files/           # 目录浏览
```

服务器的控制台会打印每一步事件，日志本身就是主循环的分镜脚本：

```
新连接：127.0.0.1:52314 (fd=7)     ← epoll 通知监听 fd 可读，accept 出新连接
收到请求：fd=7, 137 字节           ← epoll 通知客户端 fd 可读
方法: GET, 路径: /, 版本: HTTP/1.1
发送文件: ./www/index.html (2156 字节)
保持连接：fd=7                     ← HTTP/1.1 默认 Keep-Alive，连接留着
超时断开：fd=7（5 秒无请求）        ← epoll_wait 超时返回，扫描清理僵尸连接
```

压测可以验证并发能力——`ab` 是 Apache 自带的压测工具，`-n` 是总请求数，`-c` 是并发数：

```bash
ab -n 1000 -c 10 http://localhost:8080/
```

仓库里还附带一个仪表盘页面 `dashboard.html`：用 Chart.js 画 CPU/内存折线图，每 2 秒轮询一次 `GET /api/data`。再说明一次，这个接口不是本文重点——监控数据由 SystemMonitor 程序持续写入 MySQL 的 `monitor_data` 表，`api.c` 只是查询最近 60 条记录、动态构造 JSON 返回给浏览器，顺带把两个项目串了起来。

如果浏览器里开着仪表盘（每 2 秒一个请求）再跑一轮 `ab`，会看到服务器的控制台日志像流水一样滚动——**几万次请求在一个进程、一个线程里全部被处理完，这就是 I/O 多路复用的威力**。

---

## 总结

这个项目让我把三件事彻底想明白了：

**第一，HTTP 服务器的工作本质是"等待"。** 绝大部分时间里服务器什么都没干，只是在等连接、等请求、等数据。并发的关键不是"同时干很多事"，而是"用最少的资源等最多的人"。

**第二，select/poll/epoll 是三代递进的设计。** select 用固定位图，受 1024 上限约束；poll 把位图换成数组，解决了上限但保留了"每次全量拷贝 + 全量扫描"的低效；epoll 让内核长期维护监听集合，靠回调把就绪的 fd 直接送上就绪链表，把每次调用成本从 O(连接数) 降到了 O(活跃数)。**在"海量连接、低活跃度"的场景里，epoll 是 Linux 上唯一正确的答案。**

**第三，技术选型要回到场景。** 这个项目选 epoll 不是因为它"最新最酷"，而是因为 HTTP 长连接服务器就是典型的"连接多、活跃少"场景——Keep-Alive 让连接数不断累积，而 epoll 恰恰让空闲连接的成本趋近于零。反过来，如果只是几十个连接的小工具，select 反而更简单、可移植性更好。理解每种机制的适用边界，比背下它们的 API 重要得多。

| 技术点 | 具体应用 |
|:---|:---|
| **I/O 多路复用** | select → poll → epoll 三代演进，理解"一对多等待"的本质 |
| **epoll 事件驱动** | 红黑树登记 + 就绪链表通知，epoll_create1/ctl/wait 三件套 |
| **非阻塞 I/O** | 监听 fd 与客户端 fd 全部 O_NONBLOCK，防御性编程 |
| **HTTP 协议实现** | 请求行/请求头解析、状态行 + Content-Length 响应构造、MIME 检测 |
| **Keep-Alive 长连接** | HTTP/1.1 默认保持、5 秒空闲超时清理、连接复用 |
| **路径安全** | 拦截 `..` 路径遍历攻击，403 Forbidden |
| **SystemMonitor 集成** | 附带功能：`/api/data` 查询其 MySQL 监控表，供 Chart.js 仪表盘展示 |

> 完整源代码见 GitHub 仓库：[engineer-05/http-server](https://github.com/engineer-05/http-server)
