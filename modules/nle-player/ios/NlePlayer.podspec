Pod::Spec.new do |s|
  s.name           = 'NlePlayer'
  s.version        = '1.0.0'
  s.summary        = 'OneTake NLE composition player'
  s.description    = 'AVMutableComposition-backed timeline player for OneTake'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.frameworks     = 'AVFoundation', 'CoreImage', 'CoreVideo', 'QuartzCore', 'UIKit', 'Vision'
  s.platforms      = {
    :ios => '15.1',
    :tvos => '15.1'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
