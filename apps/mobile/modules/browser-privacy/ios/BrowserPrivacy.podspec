Pod::Spec.new do |s|
  s.name = 'BrowserPrivacy'
  s.version = '1.0.0'
  s.summary = 'muxr private agent-browser screen cover'
  s.description = 'Hides the private agent-browser view from the app switcher and screen capture.'
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
