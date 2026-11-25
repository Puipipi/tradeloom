# frozen_string_literal: true
#
# dsh-go 论坛初始化：站点设置、登录方式、分类、标签、界面文字。
# 在容器里用 rails runner 执行（scripts/apply.sh 会帮你调用）：
#
#   rails runner /shared/dshgo/apply_settings.rb /shared/dshgo
#
# 可重复执行：值没变的设置不会重写；已存在的分类按 slug 识别，只同步权限、
# 颜色和「已解决」开关。任何一项失败只打印警告，不影响其余项。

require "yaml"

dir = ARGV[0].presence || "/shared/dshgo"
PLACEHOLDER = "<<FILL"

def load_yaml(path)
  return {} unless File.exist?(path)
  YAML.safe_load(File.read(path), permitted_classes: [], aliases: false) || {}
end

def say(msg) = puts(msg)
def warn_line(msg) = puts("  ! #{msg}")

def placeholder?(value)
  case value
  when String
    value.include?(PLACEHOLDER)
  when Array
    value.any? { |v| placeholder?(v) }
  when Hash
    value.values.any? { |v| placeholder?(v) }
  else
    false
  end
end

def apply_setting(name, value)
  sym = name.to_sym
  unless SiteSetting.has_setting?(sym)
    warn_line "#{name}：这个 Discourse 版本没有该设置，已跳过"
    return
  end
  if SiteSetting.shadowed_settings.include?(sym)
    say "  = #{name}（已由 app.yml 的环境变量设置）"
    return
  end
  if placeholder?(value)
    warn_line "#{name}：还是占位符，先在文件里填好"
    return
  end

  if value.is_a?(Hash) && value.key?("add")
    current = SiteSetting.get(sym).to_s.split("|").map(&:strip).reject(&:empty?)
    value = (current + Array(value["add"]).map(&:to_s)).uniq.join("|")
  end

  before = SiteSetting.get(sym)
  if before.to_s == value.to_s
    say "  = #{name}"
    return
  end
  SiteSetting.set_and_log(sym, value)
  shown = SiteSetting.secret_settings.include?(sym) ? "[已设置]" : value.inspect
  say "  ✓ #{name} → #{shown}"
rescue StandardError => e
  warn_line "#{name}：#{e.message}"
end

settings = load_yaml(File.join(dir, "site_settings.yml"))
secrets = load_yaml(File.join(dir, "secrets.yml"))
community = load_yaml(File.join(dir, "community.yml"))

if secrets.empty?
  warn_line "没有找到 secrets.yml：第三方登录和 S3 备份不会启用"
end

# ── 1. 敏感值（凭据要先于 enable 开关写入，否则校验器会拒绝开启）────────
say "\n[1/5] 凭据"
secrets.each do |name, value|
  next if value.blank?
  apply_setting(name, value)
end

# ── 2. 常规设置 ────────────────────────────────────────────────────────
say "\n[2/5] 站点设置"
settings.each { |name, value| apply_setting(name, value) }

# ── 3. 登录方式开关：凭据齐全才开启 ──────────────────────────────────
say "\n[3/5] 登录方式"
providers = {
  "GitHub" => [:enable_github_logins, %i[github_client_id github_client_secret]],
  "LINUX DO" => [:openid_connect_enabled, %i[openid_connect_client_id openid_connect_client_secret]],
  "Gitee" => [:oauth2_enabled, %i[oauth2_client_id oauth2_client_secret]],
}
providers.each do |label, (flag, keys)|
  unless SiteSetting.has_setting?(flag)
    warn_line "#{label}：找不到 #{flag}，对应插件可能没加载"
    next
  end
  ready = keys.all? { |k| SiteSetting.has_setting?(k) && SiteSetting.get(k).present? }
  if ready
    apply_setting(flag, true)
  else
    say "  - #{label}：secrets.yml 里没填凭据，保持关闭"
  end
end

# ── 4. 分类与标签 ──────────────────────────────────────────────────────
say "\n[4/5] 分类与标签"
system_user = Discourse.system_user

# rails runner 的 I18n.locale 是 en：不切换的话，新分类的「关于」帖标题会是
# 「About the 公告 category」。按站点默认语言建分类。
site_locale = SiteSetting.default_locale.presence || "zh_CN"
previous_locale = I18n.locale
I18n.locale = site_locale

def sym_permissions(raw)
  return nil if raw.blank?
  raw.to_h { |group, permission| [group.to_sym, permission.to_s.to_sym] }
end

Array(community["categories"]).each do |spec|
  name = spec["name"]
  slug = spec["slug"]
  begin
    category = Category.find_by(slug: slug, parent_category_id: nil)

    if category.nil? && spec["reuse_site_setting"].present?
      reuse_id = SiteSetting.get(spec["reuse_site_setting"].to_sym).to_i
      reused = Category.find_by(id: reuse_id) if reuse_id > 0
      if reused
        old_name = reused.name
        reused.name = name
        reused.slug = slug
        reused.color = spec["color"] if spec["color"].present?
        reused.text_color = spec["text_color"] if spec["text_color"].present?
        reused.position = spec["position"] if spec.key?("position")
        reused.save!
        if reused.topic&.first_post && spec["description"].present?
          reused.topic.first_post.revise(system_user, { raw: spec["description"] }, skip_validations: true)
        end
        category = reused
        say "  ✓ 分类「#{old_name}」改为「#{name}」"
      end
    end

    if category.nil?
      category =
        Category.new(
          name: name,
          slug: slug,
          user: system_user,
          color: spec["color"],
          text_color: spec["text_color"] || "FFFFFF",
          description: spec["description"],
        )
      category.position = spec["position"] if spec.key?("position")
      perms = sym_permissions(spec["permissions"])
      category.set_permissions(perms) if perms
      category.save!
      say "  ✓ 新建分类「#{name}」（/c/#{slug}）"
    else
      category.color = spec["color"] if spec["color"].present?
      category.text_color = spec["text_color"] if spec["text_color"].present?
      perms = sym_permissions(spec["permissions"])
      category.set_permissions(perms) if perms
      category.save! if category.changed? || perms
      say "  = 分类「#{category.name}」已存在"
    end

    if spec.key?("solved")
      value = spec["solved"] ? "true" : "false"
      if category.custom_fields["enable_accepted_answers"] != value
        category.custom_fields["enable_accepted_answers"] = value
        category.save_custom_fields
        say "    已解决：#{spec["solved"] ? "开" : "关"}"
      end
    end
  rescue StandardError => e
    warn_line "分类「#{name}」：#{e.message}"
  end
end

Array(community["tags"]).each do |raw|
  tag_name = DiscourseTagging.clean_tag(raw.to_s)
  next if tag_name.blank?
  if Tag.where("lower(name) = ?", tag_name.downcase).exists?
    say "  = 标签 #{tag_name}"
  else
    Tag.create!(name: tag_name)
    say "  ✓ 新建标签 #{tag_name}"
  end
rescue StandardError => e
  warn_line "标签 #{raw}：#{e.message}"
end

I18n.locale = previous_locale

# 分类缓存的键带语言（site_categories_<locale>_…），匿名 /site.json 另有约
# 30 分钟的 Redis 缓存：不清的话网页端和 App 半小时内还看到旧分类。
begin
  I18n.with_locale(site_locale) { Site.clear_cache }
  Site.clear_anon_cache!
  say "  ✓ 已清分类缓存"
rescue StandardError => e
  warn_line "清分类缓存：#{e.message}"
end

# ── 5. 界面文字覆盖 ────────────────────────────────────────────────────
say "\n[5/5] 界面文字"
(community["translation_overrides"] || {}).each do |locale, pairs|
  pairs.each do |key, value|
    existing = TranslationOverride.find_by(locale: locale, translation_key: key)
    if existing&.value == value
      say "  = #{locale} #{key}"
    else
      TranslationOverride.upsert!(locale, key, value)
      say "  ✓ #{locale} #{key} → #{value}"
    end
  rescue StandardError => e
    warn_line "#{locale} #{key}：#{e.message}"
  end
end

say "\n完成。带 ! 的行需要处理；改完文件再执行一次即可。"
