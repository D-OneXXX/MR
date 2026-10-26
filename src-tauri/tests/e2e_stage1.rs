//! 阶段一联调：建 5 页 cbz → 入库 → 取页序/缩略图/单页 → 记进度 → 看板随之变化。
//!
//! 覆盖验收：拖入 cbz 出现封面卡片（scan→list→thumbnail 全链路）、
//! 热力图/统计随进度变化（SQL 灌测试数据验证）。
//!
//! 运行：`cargo test --manifest-path src-tauri/Cargo.toml --test e2e_stage1 -- --nocapture`

use std::io::Write;

use image::ImageEncoder as _;
use image::{Rgb, RgbImage};
use manga_reader_tauri_lib::{db, pipeline, source::ImageSource};

fn page_png(w: u32, h: u32, seed: u8) -> Vec<u8> {
    let mut img = RgbImage::new(w, h);
    for (x, y, p) in img.enumerate_pixels_mut() {
        *p = Rgb([x as u8 ^ seed, y as u8 ^ seed, seed]);
    }
    let mut buf = Vec::new();
    image::codecs::png::PngEncoder::new(&mut buf)
        .write_image(img.as_raw(), w, h, image::ExtendedColorType::Rgb8)
        .expect("encode png");
    buf
}

#[test]
fn scan_list_thumbnail_progress_dashboard() {
    let dir = std::env::temp_dir().join(format!("mr-e2e-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("tmpdir");
    let cbz = dir.join("测试卷.cbz");
    {
        let file = std::fs::File::create(&cbz).expect("create cbz");
        let mut zip = zip::ZipWriter::new(file);
        let opt = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for i in 0..5 {
            zip.start_file(format!("p{i:02}.png"), opt).expect("entry");
            zip.write_all(&page_png(120, 160, i as u8 * 40))
                .expect("write");
        }
        zip.finish().expect("finish");
    }

    // 内存库（与应用同 schema）。
    let conn = rusqlite::Connection::open_in_memory().expect("memdb");
    db::init_schema(&conn).expect("schema");

    // scan：开卷 → 5 页 → upsert。
    let src = manga_reader_tauri_lib::source::open_source(&cbz).expect("open source");
    let count = src.page_count().expect("count");
    assert_eq!(count, 5, "测试卷应为 5 页");
    let names = src.entry_names().expect("names");
    assert_eq!(names.len(), 5);
    let id = db::book_id_for_path(&cbz.to_string_lossy());
    db::upsert_book(&conn, &id, &cbz.to_string_lossy(), "测试卷", count as u32).expect("upsert");

    // list：书库出现卡片。
    let books = db::list_books(&conn, None).expect("list");
    assert_eq!(books.len(), 1);
    assert_eq!(books[0].title, "测试卷");

    // 封面 = 第一页缩略图可解。
    let raw0 = src.read_raw(0).expect("read p0");
    let thumb = pipeline::render_raw(&raw0, Some(240), Some(240)).expect("thumb");
    assert!(thumb.data_url.starts_with("data:image/jpeg;base64,"));
    assert!(thumb.width <= 240 && thumb.height <= 240);

    // 单页按需解码 + 降采样。
    let raw3 = src.read_raw(3).expect("read p3");
    let page = pipeline::render_raw(&raw3, Some(60), Some(80)).expect("page");
    assert!(page.width <= 60 && page.height <= 80);

    // 进度 0 → 3：今日页数 +3，热力图出现今天，在读为 1。
    assert_eq!(db::today_pages(&conn).expect("today0"), 0);
    db::set_progress(&conn, &id, 3, None).expect("progress");
    assert_eq!(db::today_pages(&conn).expect("today3"), 3);
    let heat = db::heatmap(&conn, 90).expect("heat");
    assert!(heat.iter().any(|(d, c)| d == &db::today_str() && *c == 3));
    // 回翻不扣减（只增不减）。
    db::set_progress(&conn, &id, 1, None).expect("back");
    assert_eq!(db::today_pages(&conn).expect("today-back"), 3);

    // 搜索命中。
    assert_eq!(db::list_books(&conn, Some("测试")).expect("q").len(), 1);
    assert_eq!(db::list_books(&conn, Some("不存在")).expect("q0").len(), 0);

    println!("E2E OK: 5页cbz入库→封面/单页可解→进度3页→今日+热力图同步");
    std::fs::remove_dir_all(&dir).ok();
}
