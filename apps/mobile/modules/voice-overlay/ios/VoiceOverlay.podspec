Pod::Spec.new do |s|
  s.name = 'VoiceOverlay'
  s.version = '1.0.0'
  s.summary = 'muxr native realtime audio bridge'
  s.description = 'Provider-neutral realtime PCM playback and audio routing for muxr.'
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
