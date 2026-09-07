---
date: '2026-09-07T17:30:00+08:00'
draft: false
title: 'C++与OpenCV实现区域入侵监控系统'
categories: ['学习记录']
tags: ['C++', 'OpenCV', '数字图像处理', '帧差法', '监控系统']
---

## 前言

大三下学期我学习了《数字图像处理》这门课程。它是一门纯理论课：课上讲的都是算法的原理——灰度化如何计算、形态学操作对图像做了什么、边缘和轮廓如何提取，配以公式推导和效果分析，却几乎没有涉及编程实现。算法在纸面上推演得很清楚，可我总忍不住想：这些方法落到真实视频的每一帧上，到底是什么效果？公式和代码之间，似乎隔着一道不小的坎。

后来我自学了 C++ 和它的 OpenCV 库。C++ 负责把算法组织成可运行的工程结构，OpenCV 则提供了图像数据结构和现成的算法接口——对我来说，它们是用来**编码实现课程理论的工具**：把课堂上只存在于公式与示意图里的方法，一行行变成真正能跑、能看的程序。

这个想法最终落地成了这篇文章要讲的 SmartMonitor：一个基于 C++17 与 OpenCV 4 的区域入侵监控系统。它不依赖任何深度学习模型，从灰度化、高斯滤波、帧差、二值化、形态学闭运算到轮廓分析，几乎覆盖了课程里最核心的几类方法，并用它们拼出一条完整的"运动检测 → 区域入侵判断 → 报警取证"链路。

这篇文章会从整体设计讲起，逐步深入到每个模块，重点记录算法落地为代码时的设计决策和踩过的坑——这些往往是纸面上的理论不会告诉你的部分。

完整源代码见 GitHub 仓库：[engineer-05/SmartMonitor](https://github.com/engineer-05/SmartMonitor)。

---

## 一、整体设计：一条视频流水线

### 需求分析

把需求拆开，一个监控系统本质上要做四件事：

1. **持续取流**——从本地视频文件或摄像头读取画面
2. **检测运动**——找出画面中"正在变化"的区域
3. **判定入侵**——判断运动目标是否进入了预设的警戒区
4. **留下证据**——报警截图、持续录像、事件日志

前两个问题由输入源和运动检测器解决，后两个才是监控系统的核心：**如何区分"动了"和"入侵了"，以及报警之后怎么办**。

### 整体处理流程

```
视频帧
  → 灰度化 + 高斯滤波（去噪）
  → 与上一帧差分（absdiff）→ 阈值二值化（帧差法）
  → 形态学闭运算（连接碎片、填补空洞）
  → 轮廓提取 + 面积过滤 → 目标外接矩形框
  → 计算目标框与警戒区的重叠比例 → 达到阈值判定入侵
  → 连续帧状态机确认 → 确认后保存截图、录像并记录事件
```

可以看到，从帧差法到形态学再到轮廓分析，这一整套都是数字图像处理课程的核心内容，只是从"单张图片"的语境搬到了"连续视频流"里——多出来的是一个"时间"维度，这正是后面状态机要解决的问题。

### 模块划分

```text
SmartMonitor/
├── CMakeLists.txt
├── config/monitor.yaml            # 全部运行参数
├── src/
│   ├── main.cpp                   # 程序入口与模块调度
│   ├── config/AppConfig.*         # YAML 配置读取与校验
│   ├── detection/MotionDetector.* # 运动目标检测
│   ├── intrusion/IntrusionDetector.* # 入侵判断与状态机
│   ├── storage/RecordingManager.* # 截图、录像、日志
│   └── utils/TimeUtils.*          # 时间工具
└── output/                        # 运行产物（自动生成）
    ├── screenshots/
    ├── recordings/
    └── events.csv
```

五个模块各司其职，`main.cpp` 只负责调度。这里有一个值得注意的设计：**配置对象 `AppConfig` 是唯一被所有模块共享的东西**，各模块的构造函数接收 `const AppConfig&`，只拷贝自己需要的参数。

```cpp
MotionDetector detector(config);            // 拷贝检测参数
IntrusionDetector intrusionDetector(config);// 拷贝警戒区参数
RecordingManager recordingManager(config);  // 拷贝输出目录参数
```

模块之间互不认识（MotionDetector 不知道 storage 的存在），依赖关系全部收敛在 `main`。这样的好处是每个模块都能独立测试，`main` 函数则清晰地展现了整个系统的骨架。

---

## 二、配置先行：用 AppConfig 管住所有参数

监控系统的参数非常多：滤波核大小、二值化阈值、警戒区坐标、触发帧数、录像时长……如果散落在代码各处，调参就是一场灾难。所以项目把所有参数集中到 `config/monitor.yaml`，由 `AppConfig` 统一加载。

### 用 OpenCV 的 FileStorage 读 YAML

配置读取用了一个取巧的方案——直接复用 OpenCV 自带的 `FileStorage`，少引入一个第三方库：

```cpp
bool AppConfig::load(const std::string &configPath)
{
    cv::FileStorage file(configPath, cv::FileStorage::READ);
    if (!file.isOpened())
    {
        std::cerr << "无法打开配置文件: " << configPath << std::endl;
        return false;
    }

    file["source_type"] >> sourceType;
    file["video_path"] >> videoPath;
    file["blur_kernel_size"] >> blurKernelSize;
    // ……其余参数同理
    file.release();

    return validate();
}
```

YAML 字段名（`source_type`）与成员变量名（`sourceType`）用了不同的命名风格，读取时靠映射关系对应起来。配置文件里每行都带了中文注释，方便使用者理解每个参数的含义。

### 为什么必须在启动时校验？

加载完配置后，还有一步 `validate()`——逐项检查参数是否处于合法范围。这一步看似啰嗦，却能避免大量运行期灾难：

- `blur_kernel_size` 若为偶数，`GaussianBlur` 运行到一半才会报错
- `warning_width` 若为 0，入侵判定里算出的重叠比例会变得毫无意义
- 越界数值在视频播放到第几千帧时才突然爆发问题，很难排查

```cpp
if (blurKernelSize <= 0 || blurKernelSize % 2 == 0)
{
    std::cerr << "配置错误: blur_kernel_size 必须是大于 0 的奇数" << std::endl;
    return false;
}
if (diffThreshold < 0 || diffThreshold > 255)
{
    std::cerr << "配置错误: diff_threshold 必须在 0 到 255 之间" << std::endl;
    return false;
}
if (minOverlapRatio <= 0.0 || minOverlapRatio > 1.0)
{
    std::cerr << "配置错误: min_overlap_ratio 必须在 0 到 1 之间" << std::endl;
    return false;
}
```

**原则是 fail-fast**：配置错误应该在程序启动的第一秒就大声报出来，而不是等到某个隐蔽的时刻。`load()` 返回 `false` 时 `main` 直接 `return -1`，绝不带病运行。

---

## 三、运动检测：帧差法找出"变化的像素"

### 为什么选帧差法？

运动检测的候选方案不少：光流法、背景建模（MOG2）、深度学习目标检测……但结合项目定位——**固定摄像头、实时性要求高、纯传统方法**——相邻帧差法是最合适的起点：

- 计算量极小，只有减法和阈值操作，实时性有保证
- 不需要训练，不需要背景模型预热
- 对固定机位场景天然适配

它的代价也很明确：只能检测"画面变化"，无法区分变化的是什么（人、车、光影都算）。这个局限后面会详细讨论。

### 检测器的完整流程

`MotionDetector` 的输入是当前帧，输出是一组运动目标矩形框：

```cpp
vector<Rect> MotionDetector::detect(const Mat &frame, Mat *motionMask)
{
    vector<Rect> targets;
    if (frame.empty())
    {
        return targets;
    }

    // ① 灰度化 + 高斯滤波：丢弃颜色信息，压掉细小噪声
    Mat currentGrayFrame;
    cvtColor(frame, currentGrayFrame, COLOR_BGR2GRAY);
    GaussianBlur(currentGrayFrame, currentGrayFrame,
                 Size(blurKernelSize_, blurKernelSize_), 0);

    // ② 第一次调用没有上一帧，只保存当前帧，不产生结果
    if (previousGrayFrame_.empty())
    {
        previousGrayFrame_ = currentGrayFrame.clone();
        if (motionMask != nullptr)
        {
            *motionMask = Mat::zeros(frame.size(), CV_8UC1);
        }
        return targets;
    }

    // ③ 帧差：当前帧与上一帧逐像素相减，静止部分差值为 0
    Mat differenceFrame, thresholdFrame;
    absdiff(currentGrayFrame, previousGrayFrame_, differenceFrame);
    // ④ 二值化：差异超过阈值的像素置 255（白），其余置 0（黑）
    threshold(differenceFrame, thresholdFrame,
              diffThreshold_, 255, THRESH_BINARY);

    // ⑤ 闭运算：先膨胀再腐蚀，连接邻近的白色碎片、填补内部空洞
    const Mat kernel = getStructuringElement(
        MORPH_RECT, Size(morphKernelSize_, morphKernelSize_));
    morphologyEx(thresholdFrame, thresholdFrame, MORPH_CLOSE, kernel);

    // ⑥ 提取轮廓，过滤面积过小的噪声
    vector<vector<Point>> contours;
    findContours(thresholdFrame, contours, RETR_EXTERNAL, CHAIN_APPROX_SIMPLE);
    for (const auto &contour : contours)
    {
        if (contourArea(contour) < minObjectArea_)
        {
            continue;
        }
        targets.push_back(boundingRect(contour)); // 用外接矩形代表目标
    }

    // ⑦ 保存当前灰度帧，供下一次比较
    previousGrayFrame_ = currentGrayFrame.clone();
    return targets;
}
```

每个步骤都能在课程里找到对应知识点，但真正实现时有几个细节值得记录：

**细节 1：为什么上一帧只存灰度图？** 直接对彩色帧做差分会把颜色通道间的差异也放大，而且灰度化后计算量降为三分之一，噪声更少。这个优化既来自课程里"灰度图像信息最简"的认识，也来自实践中的观察。

**细节 2：第一帧没有检测结果。** 帧差法需要一个"上一帧"作参照，而第一帧之前什么都没有。因此检测器内部保存了 `previousGrayFrame_`——**检测器是有状态的**，这与"写一个纯函数"的直觉不同。让状态跟随对象、由 `main` 每帧调用 `detect()`，接口就非常干净。

**细节 3：为什么要做闭运算？** 物体运动时，相邻帧在物体边缘处的差异通常不连续，呈现"边缘重影 + 内部空洞"的形态。直接找轮廓会把一个目标拆成许多碎块。闭运算（先膨胀后腐蚀）能把相邻的白色区域连成一片，同时填掉内部的空洞，让轮廓提取的结果稳定得多。

**细节 4：面积过滤是性价比最高的去噪手段。** 摄像头噪声、树叶晃动产生的差分区域通常很小。与其调高二值化阈值（会误伤真实目标），不如在轮廓层面直接丢弃面积小于 `min_object_area`（默认 300 像素）的轮廓，二者可以独立调节。

**细节 5：`motionMask` 参数是调试利器。** 它把二值化掩码输出给调用方，程序运行时会额外开一个 `threshFrame` 窗口实时显示黑白掩码。调参时直接看"算法眼中"的画面，比盯着检测框猜原因高效得多：

```cpp
imshow("frame", displayFrame);      // 标注后的彩色画面
imshow("threshFrame", motionMask);  // 二值化运动掩码，便于观察算法过程
```

---

## 四、入侵判定：重叠比例，而不是"碰到就报警"

有了目标框，下一步是判断它是否"入侵"了警戒区。最朴素的想法是：**目标框和警戒区有任何交集就算入侵**。但这个方案有个明显问题——目标只是擦着警戒区边缘路过，也会触发报警，误报率会非常高。

### 用重叠比例衡量"进入程度"

SmartMonitor 的做法是计算目标框与警戒区的**重叠比例**：

```text
重叠比例 = (目标框 ∩ 警戒区) 的面积 / 目标框的面积
```

```cpp
bool IntrusionDetector::isIntruding(const Rect &target) const
{
    if (target.area() <= 0)
    {
        return false;
    }

    // OpenCV 的 Rect 重载了 & 运算符，直接得到交集矩形，代码非常直观
    const Rect intersection = target & warningArea_;
    const double overlapRatio =
        static_cast<double>(intersection.area()) / target.area();

    return overlapRatio >= minOverlapRatio_;
}
```

这里藏着两个值得品味的点：

**1. OpenCV 的 `Rect & Rect` 是个惊喜。** 一开始我以为要手写交集计算：

```cpp
// 手写版：要考虑两矩形各种相对位置，容易出边界错误
int x1 = max(target.x, warningArea_.x);
int y1 = max(target.y, warningArea_.y);
int x2 = min(target.x + target.width, warningArea_.x + warningArea_.width);
int y2 = min(target.y + target.height, warningArea_.y + warningArea_.height);
```

结果查文档发现 OpenCV 早就用运算符重载封装好了——`target & warningArea_` 直接返回交集矩形，不相交时返回面积为零的空矩形。这个特性既简洁又不会错。

**2. 重叠比例是一个可调节的"灵敏度旋钮"。** 默认阈值是 0.15，即目标有 15% 的面积进入警戒区才算入侵。想严格些就调高，想宽松些就调低，不需要改代码。相比"中心点是否进入警戒区"的另一种常见做法，比例法对"大目标刚露头"的场景响应更快——一个大目标可能只探进警戒区 15% 的自身面积，但绝对侵入面积已经不小了。

三种标记合在一起就是运行时画面的样子：

```text
黄色：警戒区边界，由配置文件固定，画面中始终存在
绿色：运动目标框，尚未进入警戒区
红色：运动目标框，与警戒区重叠比例 ≥ min_overlap_ratio，判定为入侵
```

顺带一提，`warningArea_` 是构造函数里从配置直接构造的一个 `Rect`，`main` 每帧用 `intrusionDetector.warningArea()` 取出它画黄色框，警戒区的定义因此只有一个来源，不会出现"配置一套、代码一套"的分裂。

---

## 五、连续帧状态机：让报警稳定下来

单帧判定做完了，但**直接把单帧结论当成报警信号仍然不可用**。想象一下实际场景：

- 一只鸟从警戒区上空掠过，可能只有一两帧"入侵"
- 目标明明还在，某帧因为遮挡或算法抖动漏检了一帧
- 报警状态在 1 秒内疯狂切换，录像是有了，但根本无法作为证据

解决思路是把"一帧的结论"升级为"一段时间的结论"。SmartMonitor 用了一个三状态状态机：

```text
NORMAL
  ↓ 检测到入侵，开始累计连续帧数
CHECKING
  ↓ 连续计满 trigger_frames 帧，确认报警
WARNING
  ↓ 连续 clear_frames 帧未检测到入侵，解除报警
NORMAL（回到起点，计数器清零）
```

- **NORMAL**：一切正常
- **CHECKING**：检测到入侵，但连续帧数还没凑够，处于"观察期"
- **WARNING**：连续 `trigger_frames`（默认 3）帧都判定入侵，正式报警

```cpp
IntrusionState IntrusionDetector::update(bool hasIntrusion)
{
    // 每帧开始时清除"刚触发"标记，只有发生状态切换的帧才会置位
    justTriggered_ = false;

    // 报警中：重新检测到入侵就继续报警；连续多帧没入侵才解除
    if (state_ == IntrusionState::Warning)
    {
        if (hasIntrusion)
        {
            clearFrameCount_ = 0;   // 目标还在，重置离开计数
        }
        else if (++clearFrameCount_ >= clearFrames_)
        {
            state_ = IntrusionState::Normal;
            intrusionFrameCount_ = 0;
            clearFrameCount_ = 0;   // 全部清零，为下一次事件重新累计
        }
        return state_;
    }

    // 非报警状态且本帧无入侵：清空计数，回到 NORMAL
    if (!hasIntrusion)
    {
        intrusionFrameCount_ = 0;
        state_ = IntrusionState::Normal;
        return state_;
    }

    // 非报警状态且本帧有入侵：进入 CHECKING 并累计连续帧数
    state_ = IntrusionState::Checking;
    if (intrusionFrameCount_ < triggerFrames_)
    {
        ++intrusionFrameCount_;
    }
    if (intrusionFrameCount_ >= triggerFrames_)
    {
        state_ = IntrusionState::Warning;
        clearFrameCount_ = 0;
        justTriggered_ = true;      // 本帧刚确认报警
    }
    return state_;
}
```

这里有几个容易写错、值得记录的设计：

**为什么必须是"连续"帧而不是"累计"帧？** 如果采用累计计数，目标在 3 秒内分三次出现、每次一帧，也会凑够 3 次触发报警——这恰恰是想要滤掉的"瞬间噪声"。而连续计数在任何一个正常帧到来时都会清零重来，只有真正持续存在的变化才能累加过关。

**为什么解除报警也需要"连续"若干帧？** 单向的去抖是不够的。目标在警戒区内遮挡反光导致的偶发漏检，如果立刻解除报警，状态就会在 WARNING 和 NORMAL 之间来回抖动。给解除同样加上 `clear_frames`（默认 3）的连续要求，两边对称，抖动才真正被压住。

**`justTriggered()` 的巧妙作用。** 程序只在状态从 CHECKING 变成 WARNING 的**那一帧**需要保存截图——如果持续入侵 30 秒，每次都截图会存下一堆几乎一样的文件。`justTriggered_` 在每次 `update()` 开头被清除，只有完成状态切换的那一帧为 `true`，`main` 里只需要一次检查：

```cpp
if (intrusionDetector.justTriggered())
{
    recordingManager.saveIntrusionEvent(displayFrame, currentTime);
}
```

这样"一个入侵事件只留下第一张证据"，后续持续入侵则靠录像记录全过程。

---

## 六、报警取证：截图、分段录像与 CSV 日志

报警之后的事同样重要——**监控系统的价值最终体现在证据上**。SmartMonitor 会在 `output/` 下生成三类产物，形成一条可追溯的证据链：

```text
output/
├── screenshots/       # 入侵确认瞬间的带标注截图
├── recordings/        # 从程序启动就开始的持续分段录像
└── events.csv         # 事件索引：时间 + 截图路径 + 录像路径
```

事件日志形如：

```csv
event_id,event_time,screenshot_path,recording_path
1,2026-09-07 16:40:56,output/screenshots/2026_0907_164056.jpg,output/recordings/record_2026_0907_164030.avi
```

### 截图与日志：先落盘，再记录

`saveIntrusionEvent()` 先保存截图，成功后才把一行事件追加进 CSV。截图文件名来自 `TimeUtils::fileTimestamp()`（如 `2026_0907_164056.jpg`）——刻意不用空格和冒号，因为它们在某些文件系统上不友好，而 `年_月日_时分秒` 的格式按字典序排列就是时间顺序。

日志方面有个细节：`events.csv` 用追加模式打开，**只有文件不存在或为空时才写表头**；事件编号 `nextEventId_` 则是通过数已有数据行数得到的。这样程序重复运行不会破坏旧日志，也不会从 1 重新编号导致两张截图同名冲突。

### 持续录像：为什么必须分段？

监控录像从程序启动第一帧就开始记录，与报警与否无关——这样事件发生前的画面也不会丢。录像使用 MJPG 编码的 AVI 容器，在 Ubuntu 的 OpenCV 环境里兼容性最好。

录像分段由 `rotateIfNeeded()` 实现，**在写入每一帧之前检查**：

```cpp
bool RecordingManager::rotateIfNeeded()
{
    const double elapsedSeconds = chrono::duration<double>(
        chrono::steady_clock::now() - segmentStartTime_).count();
    if (elapsedSeconds < segmentDurationSeconds_)
    {
        return true;  // 没到分段时间，继续写当前文件
    }

    // 达到时长：先正确关闭旧文件，再用相同参数创建新文件
    close();
    return startRecording(recordingFps_, recordingFrameSize_);
}
```

分段的理由很实际：单文件无限增长，一方面文件系统和大文件读写都不友好，一旦文件损坏整段录像都不可用；另一方面，`record_2026_0907_164030.avi` 这样的命名本身就携带时间信息，配合 CSV 里记录的录像路径，任何一条事件都能立刻定位到对应片段。

还有一个时间点上的讲究：**检查必须放在写帧之前**。如果放在写帧之后，恰好卡在分段边界的那一帧会写进"超龄"的旧文件里，边界处就会缺帧或时长溢出。

### 一个小细节：录像从第一帧之后才创建

摄像头的画面尺寸在打开前是未知的，而 `VideoWriter` 创建时就必须指定帧率与尺寸。因此 `startRecording()` 被推迟到第一帧读取成功之后调用：

```cpp
if (!recordingStarted)
{
    recordingManager.startRecording(recordingFps, frame.size());
    recordingStarted = true;
}
```

同理，输入源的 FPS 若无效（比如某些视频文件读不出 `CAP_PROP_FPS`），就回退到默认值 25，否则 `VideoWriter` 会因为帧率为 0 创建失败。

---

## 七、时间工具：两个时钟的分工

时间在监控系统里有两类完全不同的用途，SmartMonitor 用 `<chrono>` 的两个时钟分别处理，这个分工值得单独记录：

- **`system_clock`**：墙钟时间，跟随系统校准，可以转换成年月日时分秒 → 用于**给人看**：画面上的时间文字、截图文件名、CSV 日志。
- **`steady_clock`**：单调时钟，只增不减，不受系统时间调整影响 → 用于**给机器算**：统计 FPS、判断录像分段时长。

```cpp
string TimeUtils::currentDateTime()
{
    const auto now = chrono::system_clock::now();
    const time_t currentTime = chrono::system_clock::to_time_t(now);

    tm localTime{};
    localtime_r(&currentTime, &localTime);  // 线程安全的 localtime

    ostringstream output;
    output << put_time(&localTime, "%Y-%m-%d %H:%M:%S");
    return output.str();
}
```

这个区分不是小题大做：如果 FPS 统计用了 `system_clock`，用户手动校时（或 NTP 自动同步）会凭空"跳变"几秒，导致实际 FPS 显示异常、录像分段提前或延后；而如果把系统时间字符串写进录像文件名，校时同样会让文件时间与真实时刻错位。**可读性与稳定性无法用同一个时钟兼顾**，所以项目把它们拆开：耗时计算一律走 `steady_clock`，人类可读时间一律走 `system_clock`。

另外，`main` 中每一帧只调用一次 `TimeUtils::currentDateTime()`，画面文字、截图、CSV 用的是同一个时间戳，保证三者严格一致——如果分别调用两次，可能跨过秒的边界，画面上的时间与日志里的时间就会差一秒，作为证据会出现瑕疵。

---

## 八、主循环：调度与健壮性

所有模块最终由 `main` 中的主循环串起来。这个循环看起来平凡，实际藏着不少健壮性处理。

### 读帧失败：文件与摄像头必须区别对待

```cpp
const bool readSucceeded = cap.read(frame);
if (!readSucceeded || frame.empty())
{
    // 本地视频读不到下一帧 = 正常播放结束，直接退出
    if (config.sourceType == "file")
    {
        cout << "视频读取结束" << endl;
        break;
    }

    // 摄像头可能偶发失败（USB 抖动等），连续失败满 maxReadFailures 才停止
    ++consecutiveReadFailures;
    if (consecutiveReadFailures >= config.maxReadFailures)
    {
        break;
    }
    // 重试等待期间仍允许用户退出
    if (waitKey(100) == 'q' || waitKey(100) == 27)
    {
        break;
    }
    continue;
}
consecutiveReadFailures = 0;
```

同样是"读不到帧"，对视频文件来说是**正常结束**，对摄像头来说可能是**偶发故障**。摄像头连续读取失败达到 `max_read_failures`（默认 5）次才退出，给 USB 摄像头留了自愈的余地；而文件读到 EOF 就直接退出，不做无意义的重试。

### 在副本上绘制，别污染检测输入

```cpp
const vector<Rect> targets = detector.detect(frame, &motionMask);

// 在副本上绘制标注，保证送入检测器的原始画面不被文字和框污染
displayFrame = frame.clone();
rectangle(displayFrame, intrusionDetector.warningArea(), Scalar(0, 255, 255), 2);
for (const Rect &target : targets)
{
    const bool isIntruding = intrusionDetector.isIntruding(target);
    const Scalar boxColor = isIntruding ? Scalar(0, 0, 255) : Scalar(0, 255, 0);
    rectangle(displayFrame, target, boxColor, 2);
}
```

`detect()` 拿原始帧做帧差，绘制则全部发生在克隆出的 `displayFrame` 上。如果直接在原帧上画框，下一帧做差分时这些框就成了"画面内容"，检测结果会被自己画上去的标注干扰——这种自我污染的错误很难一眼看出来。

颜色约定：**黄色**矩形是警戒区，**绿色**目标框表示运动但未入侵，**红色**目标框表示已达入侵比例；左上角状态文字 `NORMAL`（绿）、`CHECKING`（黄）、`WARNING`（红）与状态机一一对应。

### 测量"实际处理速度"而不是"输入帧率"

视频文件可能标称 30 FPS，但程序每帧还要做滤波、检测、编码录像，实际能处理的速度未必跟得上。项目用 `steady_clock` 每经过约 1 秒统计一次真实处理帧数：

```cpp
++processedFrameCount;
const double elapsedSeconds =
    chrono::duration<double>(steady_clock::now() - fpsStartTime).count();
if (elapsedSeconds >= 1.0)
{
    actualFps = processedFrameCount / elapsedSeconds;  // 真实吞吐
    processedFrameCount = 0;
    fpsStartTime = steady_clock::now();
}
```

画面角落显示的 `FPS` 是这条流水线的真实吞吐，调参时用来直观评估算法开销是否可接受。

主循环收尾同样有讲究：退出前必须调用 `recordingManager.close()` 释放 `VideoWriter`——否则录像缓存没有落盘，最后几秒的画面会丢失；`q`、`Q`、`Esc` 三个键在任何状态（包括摄像头重试等待期间）都能安全退出，这是测试时反复按 Ctrl+C 强杀后总结出的教训。

---

## 九、局限与展望

诚实地说，这个系统的定位是"传统计算机视觉的完整实践"，因此也有明确的边界：

- **帧差法只能检测"变化"，不能识别物体**。风中的树叶、晃动的窗帘、快速的光照变化，在它眼里和人一样是"运动目标"。这也是它只能用于固定机位、光照稳定场景的根本原因。
- **警戒区目前是单个矩形**，由配置文件指定。真实场景中警戒区往往是不规则多边形，甚至需要多个区域。
- **误报与漏报的平衡靠调参维持**。二值化阈值、面积阈值、重叠比例、触发帧数四个旋钮互相耦合，调参需要反复观察 `threshFrame` 掩码窗口才能找到合适的组合。

如果继续演进，比较自然的路径是：用 MOG2 背景建模替代帧差法以适应缓慢光照变化 → 警戒区改为多边形甚至任意区域 → 引入目标跟踪（如 KCF）把"检测-确认"升级为"跟踪-分析" → 需要识别物体类别时再引入 YOLO 等检测网络。每一步都有清晰的动机和成本，这也是传统视觉项目向深度学习过渡时很典型的一条路线。

---

## 十、总结

回顾整个项目，核心链路可以概括为：

```text
灰度化与滤波 → 相邻帧差分 → 二值化 → 形态学闭运算
→ 轮廓提取与面积过滤 → 重叠比例判入侵 → 连续帧状态机确认
→ 报警截图、持续录像与事件日志
```

如果说哈夫曼编码的项目让我体会到"数据结构的选择决定算法的形态"，那么这次 SmartMonitor 带给我的收获是：**视频处理里的每个"小坑"——第一帧没有上一帧、绘制污染检测输入、摄像头偶发读失败、时钟校时干扰耗时统计——都不是靠某本教材能学到的，只有把算法放进真实的时间流里跑起来才会遇到**。

从课程里的静态图像算法，到一个带状态机、带持久化、带退避重试的完整监控系统，中间补上的正是这些工程细节。这也是我当初想亲手写代码的初衷——把课本上的方法变成能跑、能存、能追责的软件。

完整源代码见 GitHub 仓库：[engineer-05/SmartMonitor](https://github.com/engineer-05/SmartMonitor)。
