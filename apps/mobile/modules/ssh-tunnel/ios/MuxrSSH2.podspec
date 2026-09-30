# Build upstream libssh2 from a pinned revision, with a maintained crypto backend.
# No vendored SSH or OpenSSL binary lives in the app repository.
Pod::Spec.new do |s|
  s.name = 'MuxrSSH2'
  s.version = '1.11.1'
  s.summary = 'libssh2 for muxr loopback transport'
  s.homepage = 'https://libssh2.org'
  s.license = { :type => 'BSD-3-Clause', :file => 'COPYING' }
  s.author = 'The libssh2 project and its contributors'
  s.source = { :git => 'https://github.com/libssh2/libssh2.git', :commit => '2e1717456b8dd4c980e8e48d6dbfec524c2e62d1' }
  s.platforms = { :ios => '16.4' }
  s.static_framework = true
  s.source_files = 'src/{agent,bcrypt_pbkdf,chacha,channel,cipher-chachapoly,comp,crypt,global,hostkey,keepalive,kex,knownhost,libgcrypt,mac,mbedtls,misc,openssl,os400qc3,packet,pem,poly1305,publickey,scp,session,sftp,transport,userauth,userauth_kbd_packet,version,wincng}.c', 'src/*.h', 'include/*.h'
  s.preserve_paths = 'src/blowfish.c'
  s.public_header_files = 'include/*.h'
  s.header_mappings_dir = 'include'
  s.dependency 'OpenSSL-Universal', '3.6.2000'
  # Darwin's SDK provides these interfaces on both device and simulator.
  s.compiler_flags = '-DLIBSSH2_OPENSSL -DLIBSSH2_LIBRARY -DHAVE_UNISTD_H -DHAVE_INTTYPES_H -DHAVE_SYS_SELECT_H -DHAVE_SYS_UIO_H -DHAVE_SYS_IOCTL_H -DHAVE_SYS_TIME_H -DHAVE_SYS_UN_H -DHAVE_POLL -DHAVE_O_NONBLOCK -DHAVE_FIONBIO -DHAVE_MEMSET_S'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'HEADER_SEARCH_PATHS' => '$(inherited) "$(PODS_TARGET_SRCROOT)/src" "$(PODS_TARGET_SRCROOT)/include"' }
end
