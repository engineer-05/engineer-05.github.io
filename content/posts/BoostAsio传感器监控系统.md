---
date: '2026-09-02T13:00:00+08:00'
draft: false
title: 'Boost.Asio 网络实战：30 字节自定义协议解决 TCP 粘包分包，搭建多设备传感器监控系统'
categories: ['学习记录']
tags: ['C++', 'Boost.Asio', 'TCP', '自定义协议', '粘包分包', '异步网络', 'Qt']
---

## 前言

学完 Qt 和 C++ 基础之后，一直想做一个真正把"界面 + 网络 + 存储"串起来的完整项目。于是写了 SensorMonitor——一个多设备传感器实时监控系统：虚拟传感器模拟温度、湿度、气压数据，通过网络传给服务端，界面实时显示数值曲线、触发阈值报警，数据异步落进 SQLite，还支持历史查询。

项目技术栈是 C++17 + Qt 6/QML + **Boost.Asio** + SQLite，代码和文档都在 GitHub：[engineer-05/sensor-flow](https://github.com/engineer-05/sensor-flow)。

网络部分是整个项目最核心也最"课本上讲不透"的一块——**TCP 是字节流，没有消息边界**。一次 send 的数据可能被拆成多次 recv 收到（半包），多次 send 也可能被合并成一次 recv（粘包）。这篇文章重点记录两件事：

1. 设计了一个 **30 字节的自定义二进制帧协议**，在 TCP 字节流上重新划分消息边界；
2. 基于 **Boost.Asio 异步模型**实现服务端接收与客户端发送，把半包、粘包、坏帧的恢复逻辑真正落地。

---

## 一、系统总览

### 1.1 一条数据从"产生"到"上屏"的完整链路

```
传感器模拟器(随机游走生成温湿度气压)
    ↓ 采样信号
SensorPacket 打包(设备ID + 序号 + 采样数据)
    ↓ ProtocolCodec 编码：定点数转换 + CRC16，输出 30 字节帧
AsioSensorClient 定时 1 秒 async_write 发送
    ↓ TCP 字节流
AsioSensorServer acceptor 接受连接
    ↓ 每个客户端一个 Session
Session 接收缓冲区追加字节 → 找 AA55 帧头 → 拆帧 → 解码 + CRC 校验
    ↓ 合法数据帧
AsioSensorBridge 通过 Qt 队列切回主线程
    ├→ 设备模型：实时数值、曲线、阈值报警、在线状态
    └→ SQLite 数据库线程：异步保存全部历史
```

系统里有三个线程，各干各的活：

```
Asio 网络线程：监听、连接、TCP 收发、帧解析
Qt 主线程：设备模型、告警状态、QML 界面
数据库线程：SQLite 写入和历史查询
```

网络线程不会直接碰 QML 对象，而是把解析出来的数据用 `QMetaObject::invokeMethod(..., Qt::QueuedConnection)` 排队发回 Qt 主线程——线程之间的职责边界划分得很干净。

### 1.2 两个可执行程序

| 程序 | 角色 | 说明 |
|:---|:---|:---|
| `appSensorMonitor` | 监控主程序 | Qt/QML 界面，内置 Asio 服务端（监听 9000 端口）和 SQLite |
| `AsioVirtualSensor` | 虚拟传感器 | Asio 异步客户端，模拟设备每秒上报一帧数据 |

主程序本身也是服务端，启动一个 `appSensorMonitor` 再开几个 `AsioVirtualSensor`，就是一台服务器带多台"设备"的完整系统。

---

## 二、为什么需要自定义协议：TCP 没有消息边界

写网络程序第一个绕不开的问题：**TCP 是面向字节流的协议**，它只保证字节按序到达，不保证"一次发送 = 一次接收"。

假设设备侧连续发送两帧数据，接收方实际可能遇到的情况有三种：

**粘包**：两帧数据在一次读取里全部到达，接收方拿到 60 字节，必须自己把两帧切开。

```
发送方： [帧A 30字节][帧B 30字节]
接收方： 一次读到 60 字节 ← 没有边界，怎么知道哪 30 字节是一帧？
```

**半包（拆包）**：一帧数据太大或被网络拆分，一次读取只到了 30 字节里的一部分。

```
发送方： [帧A 30字节]
接收方： 第一次读到 12 字节，第二次才读到剩下 18 字节
```

**更麻烦的组合**：帧 A 的尾部 + 帧 B 的头部混在一次读取里，甚至帧头 `AA55` 本身都被拆成两半——上次读到 `AA`，下次才读到 `55`。

所以"解决粘包分包"的本质是：**在无序的字节流上重新约定消息边界**。业界常见方案有三种：

| 方案 | 思路 | 优缺点 |
|:---|:---|:---|
| 固定长度 | 每帧定长，收满 N 字节就是完整一帧 | 最简单；定长可能浪费，变长数据不好办 |
| 分隔符 | 帧尾加 `\r\n` 之类的特殊标记 | 实现简单；业务数据里出现分隔符要转义 |
| **长度字段** | 帧头声明整帧长度，先收头再按长度收身 | 通用、灵活，是绝大多数二进制协议的选择 |

本项目最终选择了**"固定长度 + 长度字段双保险"**的组合：第一版协议帧固定 30 字节，帧头同时携带 Length 字段做声明。固定长度让拆包逻辑简单到极致，Length 字段则保留了对未来协议扩展的兼容性（后续消息类型变长时，拆包逻辑不需要重写）。

---

## 三、协议设计：30 字节传感器数据帧

### 3.1 帧格式

| 字节位置 | 长度 | 字段 | 说明 |
|:---|:---|:---|:---|
| 0～1 | 2 | Magic | 固定帧头 `0xAA55`，用来在字节流里找帧起点 |
| 2 | 1 | Version | 协议版本，当前为 `1` |
| 3 | 1 | MessageType | 消息类型，`0x01` = 传感器数据 |
| 4～5 | 2 | FrameLength | 整帧长度，当前固定为 `30` |
| 6～7 | 2 | DeviceId | 设备 ID，不允许为 `0` |
| 8～11 | 4 | Sequence | 包序号，每次发送加 1，可查丢包乱序 |
| 12～19 | 8 | Timestamp | 设备采样时间戳（毫秒） |
| 20～21 | 2 | Temperature | 有符号定点数，实际温度 × 100 |
| 22～23 | 2 | Humidity | 无符号定点数，实际湿度 × 100 |
| 24～27 | 4 | Pressure | 无符号定点数，实际气压 × 1000 |
| 28～29 | 2 | CRC16 | CRC16-CCITT-FALSE 校验值 |

所有多字节整数**大端序**。CRC 计算范围从 `Version` 开始到 `Pressure` 结束（即字节 2～27，共 26 字节），**不包含**帧头和 CRC 本身。

### 3.2 每个字段为什么这么设计

**Magic 用 `AA55` 而不是单个字节。** 同步帧头是拆包的地基，单字节 `0xAA` 在噪声字节流里出现的概率是 1/256，双字节 `0xAA55` 直接把误同步概率压到 1/65536。代价是缓冲处理上要留一个小尾巴——当缓冲区里找不到完整 `AA55` 时，末尾单独一个 `0xAA` 可能是被拆开的帧头前半段，必须保留等下一次读取，这个细节在拆包代码里专门处理。

**保留 Version 字段。** 协议几乎一定会演进，解码器看到不认识的版本号直接拒绝，而不是把未来的帧当垃圾解析出错误数据。

**FrameLength 与固定 30 字节并存。** 拆包时先收满 6 字节协议头才能读到 Length，再用它决定还差多少字节；同时设了 `MaximumFrameSize = 1024` 的封顶值，防止异常长度字段把接收缓冲区撑到无限大。

**浮点数转定点数。** 温度、湿度、气压在业务层是 `double`，但网络协议不能直接传 IEEE 754 浮点——字节序、平台差异都会坑人。所以编码时乘 100 / 1000 转成整数（温度保留两位小数，气压保留三位），解码再除回来：

```cpp
// 编码：四舍五入转定点整数
const qint16 encodedTemperature =
    static_cast<qint16>(std::lround(packet.data.temperature * 100.0));
const quint16 encodedHumidity =
    static_cast<quint16>(std::lround(packet.data.humidity * 100.0));
const quint32 encodedPressure =
    static_cast<quint32>(std::llround(packet.data.pressure * 1000.0));
```

反过来，温度为什么要用**有符号** qint16？因为可能有人把设备放到冷库里。湿度上限校验 `rawHumidity > 10000` 直接拒绝——编码值 10000 就是 100.00%，超过一定是坏数据。

**CRC16-CCITT-FALSE 放在帧尾。** 教科书里的校验和通常放数据前面，但帧尾有个实打实的好处：**可以先校验整帧完整性，再解析业务字段**，解析过程中发现 CRC 错时已经不需要回退任何状态。

### 3.3 解码的两个防御性设计

**先验 CRC，再读业务字段。** 解码函数的前半段只做一件事——读 Magic、Version、Type、Length、CRC，全部通过后才开始解析 DeviceId、Sequence、时间戳和三个传感器值：

```cpp
// CRC 位于帧尾两个字节，先校验数据完整性再解析业务字段
qsizetype crcOffset = SensorFrameSize - 2;
const quint16 receivedCrc = readUint16(bytes, crcOffset);
const QByteArrayView protectedData(
    bytes.constData() + 2,
    SensorFrameSize - 4);
const quint16 calculatedCrc = crc16CcittFalse(protectedData);

if (receivedCrc != calculatedCrc)
    return decodingFailure(errorMessage,
        QStringLiteral("CRC 校验失败"));
```

**解码到临时对象，全部成功才覆盖输出。** 任何一个字段校验失败时，调用者手里原来的 `packet` 保持原样，不会出现"解了一半、数据被污染"的中间状态。

编码端同样层层把关：DeviceId 不能为 0、时间戳不能为负、三个浮点值必须是有限数且在协议可编码范围内——非法输入在编码阶段就拦下，不让坏帧出门。

---

## 四、服务端：一个 Session 一台设备

### 4.1 accept 循环与 Session 的生命周期

服务端每次 `async_accept` 成功，就创建一个 `AsioSensorSession`（持有移动过来的 socket），插入 `m_sessions` 集合，然后**立刻登记下一次 accept**——所以天然支持多客户端同时在线：

```cpp
auto session = std::make_shared<AsioSensorSession>(
    std::move(socket), ...);

m_sessions.insert(session);
session->start();

// 接受一个客户端后立刻继续等待下一个，因此可以同时连接多个客户端。
acceptNextClient();
```

Session 继承 `enable_shared_from_this`，所有异步回调里都按值持有一份 `shared_ptr<self>`——**异步读取没完成前，Session 永远不会被提前销毁**。连接断开时由 Session 的 ClosedHandler 通知 Server 把它从集合里删掉。

这里有个小细节：构造函数里趁 socket 还活着，先把对方的 IP:端口存成字符串——断开后 socket 就查不到远端地址了，日志里会只剩"未知客户端"。

### 4.2 接收缓冲：把字节流"攒"成帧

每个 Session 维护两块数据：

```cpp
// readSome()每次把当前到达的数据先读进固定数组。
std::array<char, 4096> m_readBytes{};

// TCP没有消息边界，因此需要累计半包，并一次处理可能存在的多个帧。
QByteArray m_receiveBuffer;
```

`async_read_some` 每次最多读 4096 字节到临时数组，然后**追加**到 `m_receiveBuffer`。为什么用 `async_read_some` 而不是 `async_read`？因为前者"有多少读多少"立即返回，后者要等凑满指定字节数——字节流上我们根本不知道下一帧什么时候凑满，攒着等才是对的：

```cpp
m_socket.async_read_some(
    boost::asio::buffer(m_readBytes),
    [self](const boost::system::error_code &readError,
           std::size_t bytesRead)
    {
        // ...
        // 一次读取可能不足一帧，也可能包含多帧，所以只能追加。
        self->m_receiveBuffer.append(
            self->m_readBytes.data(),
            static_cast<qsizetype>(bytesRead));

        self->processBuffer();   // 尝试从缓冲区里取出所有完整帧

        if (!self->m_stopped)
            self->readSome();    // 继续登记下一次读取
    });
```

### 4.3 拆包主循环：processBuffer()

粘包半包处理的核心是 `processBuffer()` 里的一个 while 循环——**只要缓冲区里还能取出一帧完整数据，就继续取**。完整流程：

1. 在缓冲区里找 `AA55` 帧头；
2. 没找到 → 删除帧头前的所有无效字节；但若缓冲区**末尾恰好是单个 `0xAA`**，保留它——它可能是被 TCP 拆开的帧头前半段；
3. 找到帧头 → 删掉它前面的垃圾字节；
4. 缓冲不足 6 字节（读不到 Length）→ 直接返回，等下一次读取；
5. 读到 Length ≠ 30 → **只删第一个 `0xAA` 字节**，重新找帧头（当前 AA55 可能是数据里碰巧出现的假帧头，不能整帧吞掉）；
6. 缓冲不足 30 字节 → 半包，保留全部内容，等下一次读取；
7. 凑满 30 字节 → 先不消费，拷贝出这 30 字节交给 `ProtocolCodec` 做完整解码校验；
8. 校验失败 → 同样只删 1 个字节重新同步，**绝不把整帧直接丢弃**；
9. 校验成功 → 删除这 30 字节，更新设备 ID、重启空闲计时器、回调上层，然后继续循环处理后面可能粘着的数据。

对应代码（关键分支）：

```cpp
while (true) {
    const qsizetype magicPosition = m_receiveBuffer.indexOf(magicBytes);

    if (magicPosition < 0) {
        // 最后一个AA可能是下一次读取中AA55帧头的前半部分，需要保留。
        const bool keepLastByte =
            !m_receiveBuffer.isEmpty()
            && static_cast<quint8>(
                   static_cast<unsigned char>(
                       m_receiveBuffer.back())) == 0xAA;
        m_receiveBuffer = keepLastByte
            ? m_receiveBuffer.right(1)
            : QByteArray();
        return;
    }

    if (magicPosition > 0)
        m_receiveBuffer.remove(0, magicPosition);

    // 收满6字节协议头以后，才能读取下标4和5中的长度。
    if (m_receiveBuffer.size() < HeaderSize)
        return;

    // ... 读取 FrameLength ...

    if (frameLength != SensorFrameSize) {
        // 当前AA55可能是假帧头，只删第一个AA后重新寻找。
        m_receiveBuffer.remove(0, 1);
        reportProtocolError(...);
        continue;
    }

    // 这是半包：当前字节不够30个，保留内容等待下一次读取。
    if (m_receiveBuffer.size() < frameLength)
        return;

    // 校验成功前不消费30字节，避免假帧头吞掉后面的正常帧。
    const QByteArray frame = m_receiveBuffer.left(frameLength);

    SensorPacket packet;
    if (!ProtocolCodec::decodeSensorPacket(frame, packet, &decodeError)) {
        m_receiveBuffer.remove(0, 1);   // 只跳第一个AA，重新找帧头
        reportProtocolError(decodeError);
        continue;
    }

    // ... 绑定 deviceId、重启空闲计时 ...
    m_receiveBuffer.remove(0, frameLength);  // 只有校验通过才消费整帧

    if (m_packetHandler)
        m_packetHandler(packet);
}
```

把各种异常场景和对应的处理策略整理成一张表：

| 场景 | 处理方式 |
|:---|:---|
| 半包（不足 30 字节） | 保留缓冲区，等待下一次读取追加 |
| 一读多帧（粘包） | while 循环逐帧取出 |
| 帧头前的噪声字节 | 找到帧头后统一删除 |
| 缓冲区末尾单个 `AA` | 可能是拆开的帧头，保留 1 字节 |
| Length 字段非法 | 只删 1 字节重新同步，不吞帧 |
| CRC / 字段校验失败 | 只删 1 字节重新同步，不吞帧 |
| 协议错误 | **不断开连接**，报告错误后继续找下一帧 |

最容易被新手写错的一点：**校验失败的帧只跳一个字节而不是整帧丢弃**。因为校验失败恰恰说明这段数据里可能混着坏字节，帧头 `AA55` 也许是噪声里偶然出现的——如果整体跳过 30 字节，后面紧跟着的正常帧很可能被一起吞掉，系统就再也无法恢复同步了。

### 4.4 在线状态管理：空闲超时 + 设备 ID 绑定

拆包成功之外，Session 还有两个业务层面的设计：

**空闲超时。** 每收到一条合法数据就重启一次 5 秒空闲定时器；5 秒内没有任何合法数据（设备断电、网线断了）就 `stop()` 这个 Session。这样在线/离线状态不依赖 TCP 的 FIN——拔网线时操作系统可能根本来不及通知对端。

**设备 ID 绑定。** 同一个 TCP 连接第一次收到数据时记下 DeviceId，之后帧里的设备 ID 变了直接报错丢弃——防止一台"设备"连接上之后悄悄换身份。

服务端报离线也留了心眼：同一设备短时间内可能重连建了两个连接（旧连接还没超时断掉，新连接已经连上），只有当**最后一个**该设备 ID 的 Session 断开时，才真正上报离线，避免旧连接的断开把新连接的在线状态误杀。

---

## 五、客户端：异步连接、定时采样、安全重连

### 5.1 连接失败不可怕，定时器驱动的重连

客户端的状态机比服务端简单，但把 Asio 的**定时器**用到了极致——重连不是写死循环，而是"定时器到点 → 再试一次"：

```
启动客户端
    ↓
开启30秒连接总计时器，立即 async_connect
    ├── 失败：5 秒后定时器到点，重新连接
    └── 成功：取消30秒总计时器
                    ↓
              1 秒采样定时器
                    ↓
              模拟器生成数据 → 编码30字节帧 → async_write 异步发送
                    ├── 成功：序号+1，安排下一次采样
                    └── 失败：关闭socket → 重开30秒总计时 → 5秒后重连
```

几个值得说的点：

**30 秒"总期限"限制的是整轮连接阶段，而不是某一次尝试。** 只要在这个期限内连上一次就算成功；期间反复失败就一直 5 秒一重试。连上之后这个计时器就被取消，等发送失败掉线后重新开始一轮。如果 30 秒内始终没连上（服务端根本没启动），客户端打印提示并安全退出——**不会无限重试占着终端**。

**重试全程由定时器驱动，没有忙循环。** 每轮重试之间 `steady_timer` 到点才回调，io_context 空闲时事件循环直接让出 CPU。

### 5.2 async_write：共享缓冲区保证数据安全

发送一帧数据的完整流程：

```cpp
auto frame = std::make_shared<QByteArray>(encodedFrame);   // 共享所有权

boost::asio::async_write(
    m_socket,
    boost::asio::buffer(frame->constData(),
        static_cast<std::size_t>(frame->size())),
    [this, frame, packet](const boost::system::error_code &writeError,
                          std::size_t bytesWritten)
    {
        // ... 错误处理 / 重连 ...

        if (bytesWritten != static_cast<std::size_t>(frame->size())) {
            // 发送字节数不完整 → 关闭socket重新连接
        }

        ++m_sequence;
        scheduleNextSample();
    });
```

这里有一个必须强调的坑：`async_write` 是异步的，**函数返回后数据可能还没发完**。如果直接传局部 `QByteArray` 的缓冲区地址，函数一返回缓冲区就被销毁，回调执行时读到的就是野内存。解决办法是把帧数据 `make_shared` 包起来，让 lambda 按值捕获它——写回调持有这份 `shared_ptr` 期间，缓冲区一定活着。这是 Asio 异步编程里最常见的生命周期问题，也是 README 里专门标注"共享缓冲区保证数据在回调完成前不会被销毁"的原因。

发送回调里还有一个细节：`async_write` 保证要么全部写完要么出错返回，`bytesWritten` 理论上一定等于帧长，但代码仍然显式检查了一次——万一不等于就关闭 socket 走重连，绝不在半截数据的状态下继续自欺欺人地发下一帧。

每次发送成功 `++m_sequence`，接收端拿到不连续的序号就知道中间丢过数据。

### 5.3 定时采样与"安全停止"

采样同样用定时器：1 秒定时器到点 → 模拟器 `generateData()` 走一步随机游走（温度在 20～35℃、湿度 30～80%、气压 98～103 kPa 范围内漂移并叠加噪声，撞到边界自动拉回）→ 触发 `dataGenerated` 信号 → 编码发送 → 发送完成再安排下一次采样。整个链路没有一条线程阻塞等待。

`stop()` 设计为可重复调用且幂等：取消全部三个定时器、cancel + close socket，所有在途的异步回调都会带着 `operation_aborted` 立刻返回，回调看到 `m_stopped` 直接退出、不再安排新任务——这是 Asio 里"优雅关闭"的标准姿势。

---

## 六、Qt 与 Asio：跨线程桥接和数据落库

### 6.1 网络线程不碰 UI

主程序把 Asio 的 io_context 丢进一个独立 `std::thread` 跑 `run()`。Server 的三个回调（收到数据、协议错误、设备离线）都运行在**网络线程**上，绝不能直接去改 QML 对象——Qt 的对象不是线程安全的。桥接层的做法是统一的：

```cpp
QMetaObject::invokeMethod(
    this,
    [this, packet]() { handlePacket(packet); },
    Qt::QueuedConnection);   // 把工作排队到 Qt 主线程执行
```

网络线程只负责"把工作排进队列"，真正的模型更新全部发生在主线程。反过来，`stop()` 时用 `boost::asio::post` 把 `server->stop()` 也丢回网络线程执行，避免主线程和网络回调同时操作 socket 和 Session 集合。

### 6.2 SQLite 异步持久化

每一帧通过协议和 CRC 校验的数据都会进 SQLite 的 `sensor_readings` 表（device_id、sequence、sensor_timestamp、temperature、humidity、pressure、received_at），加 `(device_id, received_at)` 联合索引支撑按设备查最近数据。数据库操作全部在独立的工作线程里执行，主线程发请求就返回，不卡界面。

历史查询带唯一 `requestId`——用户在界面快速切换设备时，先发出的慢查询结果回来后会被判定为过期直接丢弃，不会用旧设备的数据覆盖新设备的曲线。

---

## 七、自动化测试：把粘包分包场景固化下来

网络代码最怕"看着对、跑起来偶发"——粘包分包本来就是概率事件，人工测试很难稳定复现。所以项目用 Qt Test 把关键场景固化成 9 组自动化测试，其中网络部分直接对应本文讨论的每个坑：

| 测试 | 覆盖的场景 |
|:---|:---|
| `receivesFrameSplitAcrossTwoWrites` | 一帧被拆成两次写入（半包） |
| `handlesStickyPacketsAndRecoversFromWrongLength` | 多帧粘包 + 错误长度帧的恢复 |
| `recoversFromFalseHeader` | 数据里出现假 `AA55` 帧头 |
| `rejectsWrongLengthAndRecovers` | 拒绝错误长度后能继续收正常帧 |
| `acceptsMultipleClients` | 多客户端并发连接 |
| `reconnectsWhenServerStartsLater` | 服务端晚启动，客户端自动重连成功 |
| `exitsWhenConnectionDeadlineExpires` | 30 秒连接期限到点安全退出 |
| `stopCancelsPendingOperations` | 停止后无泄漏、无崩溃 |
| 协议编解码测试 | 往返一致、CRC 损坏、长度错误、非法输入 |

测试里故意把一帧数据掰成两半发送、把两帧拼在一起发送、在合法帧之间塞噪声字节——这些在真实网络里"偶发"的场景，在测试里被确定性触发，任何一次重构破坏了拆包逻辑都会立刻被测试抓住。

---

## 总结

回头看这个项目，最值得记录的其实是两个认知：

**第一，"解决粘包分包"不是调一个 API，而是协议设计和状态管理的合力。** 帧头负责同步、长度字段负责划界、CRC 负责完整性、固定长度降低拆包复杂度，而服务端的接收缓冲区 + while 循环把"攒半包、切粘包、跳坏帧"三个动作串成了确定性的状态机。任何一环缺了，系统在真实网络下都会偶发抽风。

**第二，异步编程的一切技巧，本质都是在和"时序"与"生命周期"作斗争。** `shared_ptr` 捕获保证缓冲区活到回调完成；定时器驱动重连避免忙循环；`operation_aborted` + 幂等 `stop()` 保证优雅退出；`QueuedConnection` 保证跨线程安全。Asio 把事件循环的机制给你了，剩下的纪律要靠自己。

| 技术点 | 具体应用 |
|:---|:---|
| **自定义二进制协议** | 30 字节定长帧：AA55 帧头 + Version/Type/Length + 大端定点数 + CRC16-CCITT-FALSE |
| **TCP 粘包半包处理** | 每连接接收缓冲，找帧头、攒半包、循环切粘包、坏帧单字节跳同步 |
| **Boost.Asio 异步服务端** | acceptor 循环 + 每连接独立 Session + 5 秒空闲超时 + 多客户端 |
| **Boost.Asio 异步客户端** | 采样定时器、5 秒定时重连、30 秒连接总期限、async_write 共享缓冲 |
| **Qt/Asio 线程桥接** | 网络线程 → QueuedConnection → 主线程更新模型，post 回网络线程停止 |
| **SQLite 异步持久化** | 独立数据库线程，requestId 过滤过期查询 |
| **Qt Test 自动化** | 9 组测试固化半包、粘包、假帧头、重连、超时等场景 |

项目当前以本机虚拟传感器演示为主，README 里也列了后续计划：服务端命令下发与 ACK 应答、分级日志、数据导出、压力测试，以及生产环境必需的 TLS 和身份认证。协议头里的 Version 和 MessageType 字段已经为这些扩展留好了位置——下一版协议来的时候，拆包逻辑一行都不用改。

> 完整源代码见 GitHub 仓库：[engineer-05/sensor-flow](https://github.com/engineer-05/sensor-flow)
