# frozen_string_literal: true
#
# 安装或更新 dsh-go 分享码卡片主题组件，并挂到默认主题上。可重复执行。
#   rails runner /shared/dshgo/install_theme.rb /shared/dshgo/theme-dshgo.tar.gz

require "shellwords"

archive = ARGV[0]
abort "用法：rails runner install_theme.rb <theme-dshgo.tar.gz>" if archive.blank? || !File.exist?(archive)

info = JSON.parse(`tar -xzOf #{Shellwords.escape(archive)} theme-dshgo/about.json`)
name = info.fetch("name")

existing = Theme.find_by(name: name, component: true)
theme =
  RemoteTheme.update_zipped_theme(archive, File.basename(archive), theme_id: existing&.id)
puts "#{existing ? "已更新" : "已安装"}主题组件「#{theme.name}」（id #{theme.id}）"

default = Theme.find_default
if default.nil?
  puts "  ! 没有默认主题：请在 后台 → 外观 → 主题 里把组件加到正在使用的主题"
elsif default.child_themes.exists?(id: theme.id)
  puts "  = 已挂在默认主题「#{default.name}」上"
else
  default.add_relative_theme!(:child, theme)
  puts "  ✓ 已挂到默认主题「#{default.name}」"
end
