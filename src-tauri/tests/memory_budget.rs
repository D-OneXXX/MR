//! 阶段一内存验收（v3 缓存架构下重述）：连续请求 200 页等价路径，内存增长 ≤ 50MB。
//!
//! v3 变化：页缓存从 ±2 窗口升级为字节预算 LRU —— 200 页全部留在内存
//! （约 8-10MB 成品字节），增长红线不变。这是比旧窗口更强的验收：
//! 翻回任何一页都是 L1 内存命中（毫秒级），而总增长仍 ≤ 50MB。
//!
//! 等价路径 = 真实管线（常开句柄单页读 → pipeline Triangle 降采样 → JPEG dataURL）
//! + 真实预算缓存（ImageCache 页 LRU + 缩略图 LRU）。
//!
//! 运行：`cargo test --manifest-path src-tauri/Cargo.toml --test memory_budget -- --nocapture`

use std::io::Write;

use image::{Rgb, RgbImage};
use manga_reader_tauri_lib::{cache::ImageCache, pipeline};

// 200 页 × 400×600：足够验证 LRU 记账，又不会让测试跑太久。
const PAGES: usize = 200;
const W: u32 = 400;
const H: u32 = 600;
// 验收红线：50MB（与需求一致）。
const LIMIT_MB: f64 = 50.0;
const REQ_W: u32 = 800;
const REQ_H: u32 = 1200;

fn page_jpeg(seed: usize) -> Vec<u8> {
    let mut img = RgbImage::new(W, H);
    let s = seed as u32;
    for y in 0..H {
        for x in 0..W {
            img.put_pixel(
                x,
                y,
                Rgb([
                    ((x + y + s * 7) % 256) as u8,
                    ((x * 2 + s * 13) % 256) as u8,
                    ((y * 3 + s * 29) % 256) as u8,
                ]),
            );
        }
    }
    let mut buf = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 75)
        .encode_image(&img)
        .expect("encode test page");
    buf
}

fn build_cbz(path: &std::path::Path) {
    let file = std::fs::File::create(path).expect("create cbz");
    let mut zip = zip::ZipWriter::new(file);
    let opt =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for i in 0..PAGES {
        let name = format!("p{i:04}.jpg");
        zip.start_file(name, opt).expect("start entry");
        zip.write_all(&page_jpeg(i)).expect("write entry");
    }
    zip.finish().expect("finish cbz");
}

fn process_mb() -> f64 {
    use sysinfo::{get_current_pid, ProcessesToUpdate, System};
    let mut sys = System::new();
    let pid = get_current_pid().expect("pid");
    sys.refresh_processes(ProcessesToUpdate::Some(&[pid]));
    sys.process(pid).map(|p| p.memory() as f64 / 1024.0 / 1024.0).unwrap_or(0.0)
}

#[test]
fn two_hundred_pages_memory_growth_within_budget() {
    let dir = std::env::temp_dir().join(format!("mr-mem-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("tmpdir");
    let cbz = dir.join("vol500.cbz");
    build_cbz(&cbz);

    let cache = ImageCache::new();
    let src = manga_reader_tauri_lib::source::SourceHandle::open(&cbz).expect("open");

    // 预热 5 页后取基线（排除一次性初始化开销）。
    for i in 0..5 {
        let raw = src.read_raw(i).expect("read");
        let rendered = pipeline::render_raw(&raw, Some(REQ_W), Some(REQ_H)).expect("render");
        cache.put_page("book", i as u32, REQ_W, REQ_H, rendered);
    }
    let before = process_mb();
    let (c0, l0, p0, t0, _, _) = cache.stats();
    println!("基线: 进程 {before:.1} MB · 缓存 {c0}/{l0} B · 页 {p0} · 缩略图 {t0}");

    // 连续翻页 200 页：每页渲染后进 LRU。
    for i in 0..PAGES {
        let raw = src.read_raw(i).expect("read");
        let rendered = pipeline::render_raw(&raw, Some(REQ_W), Some(REQ_H)).expect("render");
        cache.put_page("book", i as u32, REQ_W, REQ_H, rendered);
    }

    let after = process_mb();
    let (cbytes, climit, pages, thumbs, _, _) = cache.stats();
    let growth = after - before;
    println!("终态: 进程 {after:.1} MB（增长 {growth:.1} MB）· 缓存 {cbytes} B/{climit} B · 页 {pages} · 缩略图 {thumbs}");
    println!("PAGES={PAGES} GROWTH_MB={growth:.1} CACHE_BYTES={cbytes} CACHED_PAGES={pages}");

    // v3 不变量：200 页全部留在 L1（翻回任一页毫秒命中），字节不超预算。
    assert_eq!(pages, PAGES, "200 页应全部驻留 L1（预算内）");
    assert!(cache.get_page("book", 0, REQ_W, REQ_H).is_some(), "首页应命中");
    assert!(
        cache.get_page("book", (PAGES - 1) as u32, REQ_W, REQ_H).is_some(),
        "末页应命中"
    );
    assert!(cbytes <= climit, "缓存 {cbytes} B 超出预算 {climit} B");
    assert!(
        growth <= LIMIT_MB,
        "进程内存增长 {growth:.1} MB，超过验收红线 {LIMIT_MB} MB"
    );

    // 关闭书籍：页缓存清空后，进程内存应回落到基线 ±10MB（P0 内存验收第二段）。
    cache.clear_pages();
    std::thread::sleep(std::time::Duration::from_millis(300)); // 留给分配器归还页
    let closed = process_mb();
    let closed_delta = closed - before;
    println!("关书后: {closed:.1} MB（相对基线 {closed_delta:.1} MB）");
    assert!(
        closed_delta.abs() <= 10.0,
        "关书后内存未回落：相对基线 {closed_delta:.1} MB（红线 ±10 MB）"
    );

    std::fs::remove_dir_all(&dir).ok();
}
