Pod::Spec.new do |s|
  s.name = 'PluginShortcuts'
  s.version = '1.0.0'
  s.summary = 'muxr plugin shortcut projection'
  s.description = 'Projects approved muxr plugin shortcuts into native iOS quick actions.'
  s.license = { :type => 'Apache-2.0' }
  s.author = 'muxr'
  s.homepage = 'https://trymuxr.com'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :git => 'https://github.com/umeranjum17/muxr.git' }
  s.static_framework = true
  s.source_files = '**/*.swift'
  s.dependency 'ExpoModulesCore'
end
